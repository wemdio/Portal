/**
 * Дефолтные IO-реализации для стадий: фетч страниц (SSRF-гейт +
 * cheerio-парсер websiteParser) и поиск (Serper, best-effort — см. searchIo.ts).
 *
 * Вынесены отдельно от shared.ts, чтобы модули с pure-логикой (clustering,
 * template) и юнит-тесты не подтягивали тяжёлый граф websiteParser/playwright.
 */

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { fetchAndExtract, normalizeUrl } from '@/lib/enrich/websiteParser';
import { defaultSearch } from './searchIo';
import type { VeStageContext } from './shared';

export type VeFetchTextFn = (url: string) => Promise<string>;
export type VeSearchFn = (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;

/**
 * Дефолтный фетч: нормализация URL → SSRF-гейт (DNS/приватные адреса режем
 * до первого запроса) → fetchAndExtract (главная + «о компании», ≤3000 символов).
 */
export async function defaultFetchText(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  await assertPublicWebsite(normalized);
  return fetchAndExtract(normalized);
}

export function resolveFetchText(ctx: VeStageContext): VeFetchTextFn {
  return ctx.fetchText ?? defaultFetchText;
}

export function resolveSearch(ctx: VeStageContext): VeSearchFn {
  // Рынок проекта ведёт geo Serper только в дефолтной реализации; подменённый
  // ctx.search (тесты, особые стадии) работает как раньше.
  return ctx.search ?? ((q) => defaultSearch(q, ctx.market ?? 'ru'));
}
