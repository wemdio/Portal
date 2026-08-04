/**
 * Поисковая IO-реализация для стадий, отделена от io.ts (фетч): не тянет
 * websiteParser/playwright в тесты pure-логики. Рынок проекта определяет
 * geo-параметры Serper — см. market.ts.
 */

import { serperSearch } from '@/lib/search/serperClient';
import { serperGeoForMarket, type HeMarket } from '../market';

export type HeSearchResults = Array<{ title: string; link: string; snippet?: string }>;

/** Дефолтный поиск: Serper никогда не throw'ит — нет ключа/сбой → []. */
export async function defaultSearch(q: string, market: HeMarket = 'ru'): Promise<HeSearchResults> {
  const geo = serperGeoForMarket(market);
  const items = await serperSearch(q, { num: 10, gl: geo.gl, hl: geo.hl });
  return items
    .filter((it) => typeof it.link === 'string' && it.link.length > 0)
    .map((it) => ({ title: it.title ?? '', link: it.link as string, snippet: it.snippet }));
}
