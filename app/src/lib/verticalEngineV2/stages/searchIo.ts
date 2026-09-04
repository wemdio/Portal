/**
 * Поисковая IO-реализация для стадий, отделена от io.ts (фетч): не тянет
 * websiteParser/playwright в тесты pure-логики. Рынок проекта определяет
 * geo-параметры Serper — см. market.ts.
 */

import { serperSearch } from '@/lib/search/serperClient';
import { serperGeoForMarket, type VeMarket } from '../market';

export type VeSearchResults = Array<{ title: string; link: string; snippet?: string }>;

/** Дефолтный поиск: Serper никогда не throw'ит — нет ключа/сбой → []. */
export async function defaultSearch(q: string, market: VeMarket = 'ru', signal?: AbortSignal): Promise<VeSearchResults> {
  signal?.throwIfAborted();
  const geo = serperGeoForMarket(market);
  const items = await serperSearch(q, { num: 10, gl: geo.gl, hl: geo.hl, signal });
  signal?.throwIfAborted();
  return items
    .filter((it) => typeof it.link === 'string' && it.link.length > 0)
    .map((it) => ({ title: it.title ?? '', link: it.link as string, snippet: it.snippet }));
}
