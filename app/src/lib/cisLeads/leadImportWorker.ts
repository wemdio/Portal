import 'server-only';

import Papa from 'papaparse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { findByInn, hasDadataKey, suggestByName } from '@/lib/enrich/dadataClient';

const BUCKET = 'cis-lead-imports';
const SUPABASE_BATCH_SIZE = 500;

type LeadImportJobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  source_filename: string;
  file_path: string | null;
};

function normalizeHeaderKey(key: string): string {
  return String(key ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pickFromRow(row: Record<string, unknown>, candidates: string[]): string {
  const keys = Object.keys(row);
  const normalizedToActual = new Map<string, string>();
  for (const k of keys) normalizedToActual.set(normalizeHeaderKey(k), k);

  for (const c of candidates) {
    const actual = normalizedToActual.get(normalizeHeaderKey(c));
    if (actual) {
      const v = row[actual];
      const s = String(v ?? '').trim();
      if (s) return s;
    }
  }
  return '';
}

function toRawLeadRow(params: {
  jobId: string;
  userId: string;
  rowIndex: number;
  row: Record<string, unknown>;
}) {
  const r = params.row;

  const raw_inn = pickFromRow(r, [
    'инн',
    'inn',
    'инн компании',
    'инн организация',
    'инн организации',
    'инн (организации)',
    'инн (компании)',
    'inn company',
    'inn number',
    'tax id',
    'tax_id',
    'tin',
  ]);
  const raw_company_name = pickFromRow(r, [
    'компания',
    'название',
    'краткое название',
    'наименование',
    'наименование организации',
    'company',
    'company_name',
    'organization',
    'организация',
  ]);
  const raw_site = pickFromRow(r, ['сайт', 'site', 'website', 'домен', 'domain']);
  const raw_city = pickFromRow(r, ['город', 'city']);
  const raw_region = pickFromRow(r, ['регион', 'область', 'region']);
  const raw_phone = pickFromRow(r, ['телефон', 'телефоны', 'phone', 'номер', 'mobile', 'тел', 'тел.']);
  const raw_email = pickFromRow(r, ['email', 'e-mail', 'почта', 'почта компании']);
  const raw_contact_name = pickFromRow(r, ['контакт', 'контактное лицо', 'фио', 'name', 'contact_name']);
  const raw_position = pickFromRow(r, ['должность', 'позиция', 'position', 'title']);
  const raw_notes = pickFromRow(r, ['комментарий', 'notes', 'note', 'примечание']);

  return {
    user_id: params.userId,
    import_job_id: params.jobId,
    row_index: params.rowIndex,
    raw_inn: raw_inn || null,
    raw_company_name: raw_company_name || null,
    raw_site: raw_site || null,
    raw_city: raw_city || null,
    raw_region: raw_region || null,
    raw_phone: raw_phone || null,
    raw_email: raw_email || null,
    raw_contact_name: raw_contact_name || null,
    raw_position: raw_position || null,
    raw_notes: raw_notes || null,
    raw_payload: r,
  };
}

async function updateJob(jobId: string, patch: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from('lead_import_jobs').update(patch).eq('id', jobId);
}

function normalizeInn(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 12) return digits;
  return null;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run()));
}

async function normalizeCompaniesForJob(jobId: string, userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  if (!hasDadataKey()) return;

  // Keep this bounded; the job can be resumed by re-running normalization later.
  const { data: leads, error } = await supabaseAdmin
    .from('raw_leads')
    .select('id, raw_inn, raw_company_name, raw_city, raw_region')
    .eq('import_job_id', jobId)
    .is('company_id', null)
    .limit(5000);

  if (error) throw new Error(error.message);
  const rows = (leads ?? []) as Array<{
    id: string;
    raw_inn: string | null;
    raw_company_name: string | null;
    raw_city: string | null;
    raw_region: string | null;
  }>;

  const now = new Date().toISOString();

  await mapWithConcurrency(rows, 6, async (lead) => {
    const inn = normalizeInn(lead.raw_inn);
    const name = (lead.raw_company_name ?? '').trim();
    const city = (lead.raw_city ?? '').trim();

    let suggestion = null as Awaited<ReturnType<typeof findByInn>>;
    try {
      if (inn) suggestion = await findByInn(inn);
      else if (name) suggestion = await suggestByName(name, city || undefined);
    } catch {
      suggestion = null;
    }
    if (!suggestion) return;

    const sData = suggestion.data ?? {};
    const outInn = normalizeInn(String(sData.inn ?? inn ?? '')) ?? inn;
    const outOgrn = String(sData.ogrn ?? '').trim() || null;
    const outName =
      String(sData.name?.full_with_opf ?? '').trim() ||
      String(suggestion.value ?? '').trim() ||
      name;
    if (!outName) return;
    const outShort = String(sData.name?.short_with_opf ?? '').trim() || null;
    const outRegion = String(sData.address?.data?.region ?? lead.raw_region ?? '').trim() || null;
    const outCity = String(sData.address?.data?.city ?? lead.raw_city ?? '').trim() || null;

    // Upsert by INN when available; otherwise insert best-effort row.
    let companyId: string | null = null;
    if (outInn) {
      const { data: company, error: upsertErr } = await supabaseAdmin
        .from('companies')
        .upsert(
          {
            inn: outInn,
            ogrn: outOgrn,
            name: outName,
            short_name: outShort,
            brand_name: null,
            region: outRegion,
            city: outCity,
            okved_main: null,
            employees_range: null,
            site: null,
            phone: null,
            email: null,
            source: 'dadata',
            source_confidence: 1.0,
            updated_at: now,
          },
          { onConflict: 'inn' },
        )
        .select('id')
        .single<{ id: string }>();
      if (!upsertErr && company) companyId = company.id;
    } else {
      const { data: company, error: insErr } = await supabaseAdmin
        .from('companies')
        .insert({
          inn: null,
          ogrn: outOgrn,
          name: outName,
          short_name: outShort,
          brand_name: null,
          region: outRegion,
          city: outCity,
          okved_main: null,
          employees_range: null,
          site: null,
          phone: null,
          email: null,
          source: 'dadata',
          source_confidence: 0.7,
          updated_at: now,
        })
        .select('id')
        .single<{ id: string }>();
      if (!insErr && company) companyId = company.id;
    }

    if (!companyId) return;

    await supabaseAdmin
      .from('raw_leads')
      .update({ company_id: companyId })
      .eq('id', lead.id)
      .eq('user_id', userId);
  });
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}

async function downloadJobFile(path: string): Promise<ArrayBuffer> {
  const res = await supabaseAdmin!.storage.from(BUCKET).download(path);
  if (res.error) throw new Error(res.error.message);
  return await res.data.arrayBuffer();
}

function parseCsv(bytes: ArrayBuffer): { rows: Record<string, unknown>[] } {
  const text = Buffer.from(bytes).toString('utf8');
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  if (parsed.errors?.length) {
    const msg = parsed.errors[0]?.message || 'CSV parse error';
    throw new Error(msg);
  }
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  return { rows };
}

async function parseXlsOrXlsx(bytes: ArrayBuffer): Promise<{ rows: Record<string, unknown>[] }> {
  const mod = await import('xlsx');
  const XLSX = mod.default ?? mod;
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return { rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, unknown>[];
  return { rows: json };
}

export async function runLeadImportJob(jobId: string): Promise<void> {
  if (!supabaseAdmin) {
    console.error('supabaseAdmin not configured');
    return;
  }

  const { data: job, error } = await supabaseAdmin
    .from('lead_import_jobs')
    .select('id,user_id,status,source_filename,file_path')
    .eq('id', jobId)
    .single<LeadImportJobRow>();

  if (error || !job) throw new Error(error?.message ?? 'Job not found');
  if (!job.file_path) throw new Error('Missing job file_path');

  const startedAt = new Date().toISOString();
  await updateJob(jobId, { status: 'running', started_at: startedAt, error_message: null });

  try {
    const bytes = await downloadJobFile(job.file_path);
    const ext = getExtension(job.source_filename);

    const parsed =
      ext === '.csv'
        ? parseCsv(bytes)
        : await parseXlsOrXlsx(bytes);

    const rows = parsed.rows;
    await updateJob(jobId, { total_rows: rows.length, processed_rows: 0 });

    let processed = 0;
    for (let i = 0; i < rows.length; i += SUPABASE_BATCH_SIZE) {
      const slice = rows.slice(i, i + SUPABASE_BATCH_SIZE);
      const toInsert = slice.map((row, idx) =>
        toRawLeadRow({ jobId, userId: job.user_id, rowIndex: i + idx, row }),
      );

      const { error: insErr } = await supabaseAdmin
        .from('raw_leads')
        .insert(toInsert);

      if (insErr) throw new Error(insErr.message);
      processed += toInsert.length;
      await updateJob(jobId, { processed_rows: processed });
    }

    await updateJob(jobId, { status: 'completed', completed_at: new Date().toISOString() });

    // Best-effort: normalize companies right after import.
    // If DaData is not configured or fails, import is still considered successful.
    try {
      await normalizeCompaniesForJob(jobId, job.user_id);
    } catch {
      // non-critical
    }
  } catch (e) {
    await updateJob(jobId, {
      status: 'failed',
      error_message: e instanceof Error ? e.message : 'Import error',
      completed_at: new Date().toISOString(),
    });
    throw e;
  }
}

