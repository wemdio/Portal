import { createHash, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { extractCompanyIds } from '@/lib/companiesSearch/seenJournal';
import { buildCompanyExportFiles, EXPORT_CONTENT_TYPES, type ExportFormat } from '@/lib/companiesSearch/exportFile';
import { companyExportFilterKey, companyExportRequestSchema } from '@/lib/companiesSearch/exportFilters';
import {
  createMainS3DownloadUrl, deleteMainS3Object, getMainS3ObjectBuffer, putMainS3Object,
} from '@/lib/mainS3Server';
import {
  getClientTariffRow, resolveEffectiveLimits, getBillingPeriodStart, countClientRows,
  getClientStatus, isClientToolAccessAllowed, isAwaitingFirstPayment,
  TOOL_ACCESS_DENIED_MESSAGE, AWAITING_PAYMENT_MESSAGE,
} from '@/lib/tariffs';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;
const CHUNK_SIZE = 5000;
const SELECT = 'id,row_count,created_at,request_key,filter_hash,filters,storage_prefix';
const FORMATS: ExportFormat[] = ['xlsx', 'csv'];

type SavedExport = {
  id: number;
  row_count: number;
  created_at: string;
  request_key: string;
  filter_hash: string;
  filters: Record<string, unknown>;
  storage_prefix: string;
};

async function access(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result;
  const tariff = await getClientTariffRow(result.auth.userId);
  if (!isClientToolAccessAllowed(getClientStatus(tariff))) {
    return { error: jsonError(TOOL_ACCESS_DENIED_MESSAGE, 403) };
  }
  if (isAwaitingFirstPayment(tariff)) {
    return { error: jsonError(AWAITING_PAYMENT_MESSAGE, 403) };
  }
  return { userId: result.auth.userId, tariff };
}

function summary(saved: SavedExport) {
  return { id: String(saved.id), rowCount: saved.row_count, createdAt: saved.created_at, filters: saved.filters };
}

async function download(saved: SavedExport, format: ExportFormat, req: NextRequest) {
  const filename = `companies_${saved.created_at.slice(0, 10)}_${saved.id}.${format}`;
  // Keep already-open pre-upgrade pages working: they expect a file, not JSON.
  if (req.method === 'POST' && !req.headers.get('accept')?.includes('application/json')) {
    const file = await getMainS3ObjectBuffer(`${saved.storage_prefix}.${format}`);
    if (!file) throw new Error('Saved export file missing');
    return new NextResponse(new Uint8Array(file), { headers: {
      'Content-Type': EXPORT_CONTENT_TYPES[format],
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Rows-Count': String(saved.row_count), 'Cache-Control': 'private, no-store',
    } });
  }
  const downloadUrl = await createMainS3DownloadUrl({
    key: `${saved.storage_prefix}.${format}`, downloadFilename: filename, expiresInSeconds: 600,
  });
  return NextResponse.json({ ...summary(saved), filename, downloadUrl }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

/** History and downloads are owner-scoped and never consume quota. */
export async function GET(req: NextRequest) {
  const result = await access(req);
  if ('error' in result) return result.error;
  try {
    if (!supabaseAdmin) throw new Error('Database unavailable');
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (id) {
      const format = url.searchParams.get('format');
      if (!/^\d+$/.test(id) || (format !== 'csv' && format !== 'xlsx')) return jsonError('Некорректная выгрузка', 400);
      const { data, error } = await supabaseAdmin.from('client_companies_search_exports')
        .select(SELECT).eq('user_id', result.userId).eq('id', id).not('storage_prefix', 'is', null).maybeSingle();
      if (error) throw error;
      if (!data) return jsonError('Выгрузка не найдена', 404);
      return await download(data as SavedExport, format, req);
    }
    const { data, error } = await supabaseAdmin.from('client_companies_search_exports')
      .select(SELECT).eq('user_id', result.userId).not('storage_prefix', 'is', null)
      .order('id', { ascending: false }).limit(10);
    if (error) throw error;
    return NextResponse.json({ exports: (data as SavedExport[]).map(summary) }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('[companies-export] Read failed', error);
    return jsonError('Не удалось открыть сохранённые выгрузки. Попробуйте ещё раз.', 500);
  }
}

export async function POST(req: NextRequest) {
  const result = await access(req);
  if ('error' in result) return result.error;
  const format = new URL(req.url).searchParams.get('format') ?? 'xlsx';
  if (format !== 'csv' && format !== 'xlsx') return jsonError('Неподдерживаемый формат', 400);
  const parsed = companyExportRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Проверьте параметры выгрузки', 400);
  const { exportRequestId, ...filters } = parsed.data;
  const filterHash = createHash('sha256').update(companyExportFilterKey(filters)).digest('hex');
  const periodStart = getBillingPeriodStart(result.tariff);
  // Ordinary downloads reuse the latest snapshot for these filters, including
  // after reload or quota exhaustion. Only "new export" supplies a UUID.
  const requestKey = exportRequestId ?? createHash('sha256')
    .update(`${filterHash}:${periodStart}`).digest('hex');

  try {
    if (!supabaseAdmin) throw new Error('Database unavailable');
    let query = supabaseAdmin.from('client_companies_search_exports').select(SELECT)
      .eq('user_id', result.userId).not('storage_prefix', 'is', null);
    query = exportRequestId ? query.eq('request_key', requestKey) : query.eq('filter_hash', filterHash);
    const { data: existing, error: lookupError } = await query.order('id', { ascending: false }).limit(1).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      if (existing.filter_hash !== filterHash) return jsonError('Параметры выгрузки изменились. Соберите базу заново.', 409);
      return await download(existing as SavedExport, format, req);
    }

    const { data: last, error: lastError } = await supabaseAdmin.from('client_companies_search_exports')
      .select('id').eq('user_id', result.userId).order('id', { ascending: false }).limit(1).maybeSingle();
    if (lastError) throw lastError;
    const limits = resolveEffectiveLimits(result.tariff);
    const usedRows = await countClientRows(result.userId, periodStart);
    const remaining = Math.max(0, limits.max_rows - usedRows);
    if (remaining <= 0) return jsonError('Лимит по тарифу исчерпан. Сохранённые выгрузки можно скачать повторно бесплатно.', 429);

    const seenOpts = filters.includeSeen ? undefined : { excludeSeenForUser: result.userId };
    const rows: Record<string, unknown>[] = [];
    for (;;) {
      const want = Math.min(CHUNK_SIZE, remaining - rows.length);
      if (want <= 0) break;
      const batch = await searchRows(filters, want, rows.length, seenOpts);
      if (batch.error) throw new Error(batch.error);
      rows.push(...batch.rows);
      if (batch.rows.length < want) break;
    }
    if (!rows.length) return jsonError('Нет данных по заданным фильтрам', 404);
    const ids = extractCompanyIds(rows);
    if (new Set(ids).size !== rows.length) throw new Error('Invalid or duplicate company IDs');
    const files = buildCompanyExportFiles(rows);
    // Unique attempt paths: a concurrent retry must never overwrite the winner.
    const prefix = `companies-search/${result.userId}/${randomUUID()}`;
    const cleanup = async () => {
      const outcomes = await Promise.allSettled(FORMATS.map((f) => deleteMainS3Object(`${prefix}.${f}`)));
      if (outcomes.some((r) => r.status === 'rejected')) console.error('[companies-export] Orphan cleanup failed', prefix);
    };
    try {
      // Await every upload before cleanup: a still-running PUT could recreate a deleted object.
      const uploads = await Promise.allSettled(FORMATS.map((f) => putMainS3Object({
        key: `${prefix}.${f}`, body: files[f], contentType: EXPORT_CONTENT_TYPES[f], cacheControl: 'private, no-store',
      })));
      if (uploads.some((r) => r.status === 'rejected')) throw new Error('Export upload failed');
    } catch (error) {
      await cleanup();
      throw error;
    }

    const { data, error } = await supabaseAdmin.rpc('commit_companies_search_export', {
      p_user_id: result.userId, p_request_key: requestKey, p_filter_hash: filterHash,
      p_filters: filters, p_storage_prefix: prefix, p_company_ids: ids,
      p_remaining: remaining, p_last_export_id: last?.id ?? 0,
    });
    // A network error may hide a successful commit. Keep files on unknown
    // outcomes; the same request key will recover that export on retry.
    if (error) {
      if (error.message?.includes('EXPORT_QUOTA_CHANGED')) {
        await cleanup();
        return jsonError('Остаток лимита изменился во время подготовки. Повторите скачивание.', 409);
      }
      throw error;
    }
    const saved = (data as SavedExport[] | null)?.[0];
    if (!saved) throw new Error('Export commit returned no row');
    if (saved.storage_prefix !== prefix) await cleanup();
    return await download(saved, format, req);
  } catch (error) {
    console.error('[companies-export] Preparation failed', error);
    return jsonError('Не удалось подготовить файл. Повторите скачивание: готовая выгрузка будет использована без нового списания.', 500);
  }
}
