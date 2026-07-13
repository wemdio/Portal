import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { recordSeenCompanies } from '@/lib/companiesSearch/seenJournal';
import { logAudit } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/admin/users/[id]/companies-seen/import
 * Body: { inns: string[], exported_at?: string }
 *
 * Бэкфилл seen-журнала B2B-поиска для СУЩЕСТВУЮЩЕГО клиента: админ загружает
 * его старую CSV-выгрузку (парсится в браузере → сюда приходят ИНН), мы
 * резолвим ИНН → companies_directory.id через существующий fetch-RPC и
 * помечаем компании выгруженными задним числом (source='backfill_csv').
 * Идемпотентно: повторный импорт того же файла ничего не дублирует и не
 * перезаписывает более ранние даты.
 */

const INN_RE = /^\d{10}$|^\d{12}$/;
const MAX_INNS = 100_000;
const RESOLVE_BATCH = 500;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  const { id: targetUserId } = await ctx.params;

  let body: { inns?: unknown; exported_at?: unknown };
  try {
    body = (await req.json()) as { inns?: unknown; exported_at?: unknown };
  } catch {
    return jsonError('Invalid body', 400);
  }

  const rawInns = Array.isArray(body.inns) ? body.inns : [];
  const inns = [...new Set(
    rawInns
      .map((v) => String(v ?? '').trim())
      .filter((v) => INN_RE.test(v)),
  )];
  if (inns.length === 0) return jsonError('В файле не найдено ни одного ИНН', 400);
  if (inns.length > MAX_INNS) {
    return jsonError(`Слишком много ИНН за один импорт (макс ${MAX_INNS.toLocaleString('ru-RU')})`, 400);
  }

  let exportedAt: string | undefined;
  if (typeof body.exported_at === 'string' && body.exported_at.trim()) {
    const d = new Date(body.exported_at);
    if (Number.isNaN(d.getTime())) return jsonError('Некорректная дата exported_at', 400);
    exportedAt = d.toISOString();
  }

  // ИНН → id через существующий fetch-RPC (p_inn_list): не требует новых
  // грантов на companies_directory и повторяет фильтры боевой выгрузки.
  // Внутри пачки резолв ПАГИНИРУЕТСЯ: у одного ИНН в базе может быть
  // несколько строк (дубли каталога), и один запрос лимитом = размеру пачки
  // молча обрезал бы хвост. Seen-исключения здесь нет, предикат стабилен
  // (ORDER BY id) — offset-пагинация корректна.
  const companyIds: number[] = [];
  const matchedInns = new Set<string>();
  for (let i = 0; i < inns.length; i += RESOLVE_BATCH) {
    const batch = inns.slice(i, i + RESOLVE_BATCH);
    let offset = 0;
    for (;;) {
      const { rows, error } = await searchRows(
        { innList: batch, includeIp: true },
        RESOLVE_BATCH,
        offset,
      );
      if (error) return jsonError(`Ошибка поиска по ИНН: ${error}`, 500);
      if (rows.length === 0) break;
      for (const r of rows) {
        const id = typeof r.id === 'number' ? r.id : Number(r.id);
        if (Number.isFinite(id) && id > 0) {
          companyIds.push(id);
          if (typeof r.inn === 'string') matchedInns.add(r.inn);
        }
      }
      if (rows.length < RESOLVE_BATCH) break;
      offset += rows.length;
    }
  }

  const { ok } = await recordSeenCompanies(targetUserId, companyIds, 'backfill_csv', exportedAt);
  if (!ok) return jsonError('Не удалось записать журнал', 500);

  void logAudit('admin.companies_seen.import', 'Backfilled companies-search seen journal', {
    targetUserId,
    totalInns: inns.length,
    matchedCompanies: companyIds.length,
    exportedAt: exportedAt ?? 'now',
    adminId: auth.auth.user.id,
  });

  return NextResponse.json({
    ok: true,
    total_inns: inns.length,
    matched_companies: companyIds.length,
    unmatched_inns: inns.length - matchedInns.size,
  });
}
