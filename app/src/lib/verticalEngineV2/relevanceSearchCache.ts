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

// Reuse discovery, never a relevance/email verdict. The reader still visits
// the site and verifies its identity.
//
// 17.09.2026 оба срока подняты до 30 суток по решению владельца движка:
// сайт компании за месяц почти не меняется, а платить за один и тот же
// запрос раз в сутки — это ровно та трата, ради которой кэш и заводили.
// Цена решения для пустого ответа: если поисковик в момент запроса временно
// не видел компанию, «сайта нет» держится месяц, а не час. Чтобы вернуть
// такую компанию в работу раньше, строку надо удалить из ve_search_cache.
export const VE_SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const VE_EMPTY_SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
  if (!Array.isArray(value) || value.length > MAX_CACHED_ITEMS) return null;
  const items = value.filter((item): item is SerperOrganicItem =>
    item != null && typeof item === 'object' && typeof (item as SerperOrganicItem).link === 'string');
  return items.length === value.length ? items : null;
}

export function freshVeSearchCacheItems(record: { results: unknown; created_at: unknown }, now = Date.now()): SerperOrganicItem[] | null {
  const items = usableItems(record.results);
  const age = now - Date.parse(String(record.created_at));
  if (!items || !Number.isFinite(age) || age < 0
    || age >= (items.length ? VE_SEARCH_CACHE_TTL_MS : VE_EMPTY_SEARCH_CACHE_TTL_MS)) return null;
  return items;
}

/** Ответ из кэша либо null — промах, просроченная запись или недоступный кэш. */
export async function readVeSearchCache(query: string, signal?: AbortSignal): Promise<SerperOrganicItem[] | null> {
  signal?.throwIfAborted();
  if (!supabaseAdmin) return null;
  const hash = veSearchCacheKey(query);
  try {
    const { data, error } = await supabaseAdmin.from('ve_search_cache')
      .select('results,created_at,hits').eq('query_hash', hash)
      .abortSignal(signal ? AbortSignal.any([signal, AbortSignal.timeout(CACHE_TIMEOUT_MS)])
        : AbortSignal.timeout(CACHE_TIMEOUT_MS)).maybeSingle();
    signal?.throwIfAborted();
    if (error || !data) return null;
    const items = freshVeSearchCacheItems(data);
    if (!items) return null;
    // Best-effort diagnostic only: simultaneous increments can race. Do not
    // present this counter as a reconciled count of saved provider credits.
    void supabaseAdmin.from('ve_search_cache')
      .update({ hits: Number(data.hits ?? 0) + 1, last_used_at: new Date().toISOString() })
      .eq('query_hash', hash).abortSignal(AbortSignal.timeout(CACHE_TIMEOUT_MS))
      .then(() => undefined, () => undefined);
    return items;
  } catch {
    signal?.throwIfAborted();
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
export function createVeCachedSearch(adapters: {
  read: typeof readVeSearchCache; write: typeof writeVeSearchCache;
  search: typeof searchVeRelevanceWebsites;
}) {
  type Flight = { controller: AbortController; promise: Promise<SerperOrganicItem[]>; waiters: number; settled: boolean };
  const flights = new Map<string, Flight>();
  return async (query: string, signal?: AbortSignal): Promise<SerperOrganicItem[]> => {
    signal?.throwIfAborted();
    const key = veSearchCacheKey(query);
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = { controller, waiters: 0, settled: false, promise: Promise.resolve().then(async () => {
        const cached = await adapters.read(query, controller.signal);
        controller.signal.throwIfAborted();
        if (cached !== null) return cached;
        const items = await adapters.search(query, controller.signal);
        // Preserve a paid successful response even if the final waiter leaves
        // during this bounded, best-effort write. Failures never reach the cache.
        await adapters.write(query, items);
        return items;
      }) };
      flight = created;
      flights.set(key, created);
      const finished = () => {
        created.settled = true;
        if (flights.get(key) === created) flights.delete(key);
      };
      void created.promise.then(finished, finished);
    }
    const shared = flight;
    shared.waiters += 1;
    return new Promise<SerperOrganicItem[]>((resolve, reject) => {
      let done = false;
      const leave = () => {
        done = true;
        signal?.removeEventListener('abort', abort);
        shared.waiters -= 1;
        if (!shared.waiters && !shared.settled) {
          if (flights.get(key) === shared) flights.delete(key);
          shared.controller.abort();
        }
      };
      const abort = () => { if (!done) { leave(); reject(signal?.reason); } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      void shared.promise.then((items) => {
        if (done) return;
        leave(); resolve(items.map((item) => ({ ...item })));
      }, (error: unknown) => {
        if (done) return;
        leave(); reject(error);
      });
    });
  };
}

// One active provider request per normalized query within this worker; the
// existing database cache shares finished results across workers/redeploys.
export const searchVeRelevanceWebsitesCached = createVeCachedSearch({
  read: readVeSearchCache, write: writeVeSearchCache, search: searchVeRelevanceWebsites,
});
