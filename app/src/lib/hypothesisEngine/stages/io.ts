/**
 * Дефолтные IO-реализации для стадий: фетч страниц (SSRF-гейт +
 * cheerio-парсер websiteParser) и поиск (Serper, best-effort).
 *
 * Вынесены отдельно от shared.ts, чтобы модули с pure-логикой (clustering,
 * template) и юнит-тесты не подтягивали тяжёлый граф websiteParser/playwright.
 */

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { fetchAndExtract, normalizeUrl } from '@/lib/enrich/websiteParser';
import { serperSearch } from '@/lib/search/serperClient';
import type { HeStageContext } from './shared';

export type HeFetchTextFn = (url: string) => Promise<string>;
export type HeSearchFn = (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;

/**
 * Дефолтный фетч: нормализация URL → SSRF-гейт (DNS/приватные адреса режем
 * до первого запроса) → fetchAndExtract (главная + «о компании», ≤3000 символов).
 */
export async function defaultFetchText(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  await assertPublicWebsite(normalized);
  return fetchAndExtract(normalized);
}

/** Дефолтный поиск: Serper никогда не throw'ит — нет ключа/сбой → []. */
export async function defaultSearch(q: string): Promise<Array<{ title: string; link: string; snippet?: string }>> {
  const items = await serperSearch(q, { num: 10 });
  return items
    .filter((it) => typeof it.link === 'string' && it.link.length > 0)
    .map((it) => ({ title: it.title ?? '', link: it.link as string, snippet: it.snippet }));
}

export function resolveFetchText(ctx: HeStageContext): HeFetchTextFn {
  return ctx.fetchText ?? defaultFetchText;
}

export function resolveSearch(ctx: HeStageContext): HeSearchFn {
  return ctx.search ?? defaultSearch;
}
