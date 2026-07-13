import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';

/**
 * Seen-журнал B2B-поиска: какие компании клиент уже выгружал и когда.
 * Журнал бессрочный; повтор уже выгруженных — только явной галочкой
 * include_seen в поиске/экспорте. См. миграцию 20260712_0001.
 */

const UPSERT_CHUNK = 1000;

/** Достаёт числовые id компаний из строк RPC-выдачи. */
export function extractCompanyIds(rows: Array<Record<string, unknown>>): number[] {
  const ids: number[] = [];
  for (const r of rows) {
    const id = typeof r.id === 'number' ? r.id : Number(r.id);
    if (Number.isFinite(id) && id > 0) ids.push(id);
  }
  return ids;
}

/**
 * Помечает компании выгруженными для клиента. Идемпотентно: повторная выгрузка
 * той же компании НЕ перезаписывает исходную дату (ignoreDuplicates) — журнал
 * отвечает на вопрос «когда выдали впервые». Best-effort: сбой записи журнала
 * не валит саму выгрузку (клиент уже получил файл), но логируется.
 */
export async function recordSeenCompanies(
  userId: string,
  companyIds: number[],
  source: 'export' | 'backfill_csv' = 'export',
  exportedAt?: string,
): Promise<{ ok: boolean }> {
  if (!supabaseAdmin || companyIds.length === 0) return { ok: true };
  const stamp = exportedAt ?? new Date().toISOString();
  try {
    for (let i = 0; i < companyIds.length; i += UPSERT_CHUNK) {
      const chunk = companyIds.slice(i, i + UPSERT_CHUNK).map((company_id) => ({
        user_id: userId,
        company_id,
        exported_at: stamp,
        source,
      }));
      const { error } = await supabaseAdmin
        .from('client_companies_search_seen')
        .upsert(chunk, { onConflict: 'user_id,company_id', ignoreDuplicates: true });
      if (error) throw error;
    }
    return { ok: true };
  } catch (err) {
    await logError('companies_search.seen.record_failed', err, {
      userId,
      count: companyIds.length,
      source,
    });
    return { ok: false };
  }
}

/** Сводка для UI: сколько всего выгружено и когда в последний раз. */
export async function getSeenStats(
  userId: string,
): Promise<{ seenTotal: number; lastExportedAt: string | null }> {
  if (!supabaseAdmin) return { seenTotal: 0, lastExportedAt: null };
  try {
    const [countRes, lastRes] = await Promise.all([
      supabaseAdmin
        .from('client_companies_search_seen')
        .select('company_id', { count: 'exact', head: true })
        .eq('user_id', userId),
      supabaseAdmin
        .from('client_companies_search_seen')
        .select('exported_at')
        .eq('user_id', userId)
        .order('exported_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      seenTotal: countRes.count ?? 0,
      lastExportedAt: (lastRes.data as { exported_at?: string } | null)?.exported_at ?? null,
    };
  } catch {
    return { seenTotal: 0, lastExportedAt: null };
  }
}
