import 'server-only';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { searchVeRelevanceWebsites } from './relevanceSearch';

/**
 * Общий кэш поисков Serper на все проекты и базы движка вертикалей.
 *
 * Зачем: поисковый запрос строится детерминированно из ИНН либо названия
 * с адресом компании (см. relevanceEvidence), поэтому одна и та же компания
 * в двух проектах — это один и тот же оплаченный запрос, а перезапуск этапа
 * сборки базы переспрашивает уже оплаченное. 16.09.2026 таких запросов вышло
 * 39 093 за сутки против 3 930 накануне, и дневной баланс Serper кончился.
 *
 * Границы намеренно узкие:
 *  - кладём ТОЛЬКО удачные ответы. Таймаут и отказ провайдера ответом не
 *    являются: закэшировав их, мы превратили бы разовый сбой сети в «у этой
 *    компании нет сайта» на весь TTL;
 *  - любая ошибка самого кэша — это не ошибка поиска. Читать не смогли —
 *    идём в Serper как раньше; записать не смогли — ответ уже получен и
 *    отдаётся вызывающему. Кэш не имеет права уронить оплаченную работу;
 *  - попадание в кэш не проходит через учёт расходов (beginProviderUsage):
 *    денег не потрачено, а журнал и так пишет по две строки на запрос.
 */

// Сайт компании — величина медленная: за месяц он не переезжает, а вот
// «не нашли сайт» за месяц вполне может устареть, поэтому TTL общий и
// умеренный, а не вечный.
export const VE_SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Serper и так отдаёт 6 позиций, а движок берёт из них не больше шести:
// хранить больше нечего, а в БД это лишние килобайты на строку.
const MAX_CACHED_ITEMS = 6;
const CACHE_TIMEOUT_MS = 2_000;

export function veSearchCacheKey(query: string): string {
  // Нормализуем пробелы и регистр: запрос собирается из полей БД, и лишний
  // пробел в адресе не должен делать из попадания промах.
  return createHash('sha256').update(query.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
}

function usableItems(value: unknown): SerperOrganicItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is SerperOrganicItem =>
    item != null && typeof item === 'object' && typeof (item as SerperOrganicItem).link === 'string');
  return items.length === value.length ? items : null;
}

/** Ответ из кэша либо null — промах, просроченная запись или недоступный кэш. */
export async function readVeSearchCache(query: string): Promise<SerperOrganicItem[] | null> {
  if (!supabaseAdmin) return null;
  const hash = veSearchCacheKey(query);
  try {
    const { data, error } = await supabaseAdmin.from('ve_search_cache')
      .select('results,created_at,hits').eq('query_hash', hash)
      .abortSignal(AbortSignal.timeout(CACHE_TIMEOUT_MS)).maybeSingle();
    if (error || !data) return null;
    const age = Date.now() - Date.parse(String(data.created_at));
    if (!Number.isFinite(age) || age > VE_SEARCH_CACHE_TTL_MS) return null;
    const items = usableItems(data.results);
    if (!items) return null;
    // Счётчик попаданий — прямая мера экономии, но ради него не ждём: ответ
    // у нас уже есть, и запись статистики не должна задерживать проверку.
    void supabaseAdmin.from('ve_search_cache')
      .update({ hits: Number(data.hits ?? 0) + 1, last_used_at: new Date().toISOString() })
      .eq('query_hash', hash).abortSignal(AbortSignal.timeout(CACHE_TIMEOUT_MS))
      .then(() => undefined, () => undefined);
    return items;
  } catch {
    return null;
  }
}

/** Сохраняет удачный ответ. Провал записи молчаливый: платить уже не нужно. */
export async function writeVeSearchCache(query: string, items: SerperOrganicItem[]): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('ve_search_cache').upsert({
      query_hash: veSearchCacheKey(query),
      query_preview: query.trim().slice(0, 300),
      results: items.slice(0, MAX_CACHED_ITEMS),
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      hits: 0,
    }, { onConflict: 'query_hash' }).abortSignal(AbortSignal.timeout(CACHE_TIMEOUT_MS));
  } catch { /* Кэш — ускоритель, а не источник истины. */ }
}

/**
 * Поиск сайта компании с общим кэшем. Обёртка отдельно от самого транспорта
 * (relevanceSearch) намеренно: тот остаётся чистым «запрос → Serper», а
 * решение «платить или взять готовое» принимает читатель доказательств.
 */
export async function searchVeRelevanceWebsitesCached(query: string, signal?: AbortSignal): Promise<SerperOrganicItem[]> {
  const cached = await readVeSearchCache(query);
  if (cached) return cached;
  const items = await searchVeRelevanceWebsites(query, signal);
  // Кладём и пустой ответ: «Serper по этому запросу ничего не нашёл» — такой
  // же оплаченный факт, как и найденный сайт, и переспрашивать его на каждом
  // перезапуске этапа незачем.
  await writeVeSearchCache(query, items);
  return items;
}
