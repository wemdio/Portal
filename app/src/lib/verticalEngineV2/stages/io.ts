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
import { withVeDeadline } from '../operationDeadline';
import type { VeStageContext } from './shared';

export type VeFetchTextFn = (url: string) => Promise<string>;
export type VeSearchFn = (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;

const DNS_TIMEOUT_MS = 8000;
const WEBSITE_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Дефолтный фетч: нормализация URL → SSRF-гейт (DNS/приватные адреса режем
 * до первого запроса) → fetchAndExtract (главная + «о компании», ≤3000 символов).
 */
export async function defaultFetchText(url: string, parent?: AbortSignal): Promise<string> {
  const normalized = normalizeUrl(url);
  return withVeDeadline('website extraction', WEBSITE_TIMEOUT_MS, parent, async (signal) => {
    await withVeDeadline('website DNS', DNS_TIMEOUT_MS, signal, () => assertPublicWebsite(normalized));
    // DNS lookup cannot be cancelled. Its late result must never start HTTP.
    signal.throwIfAborted();
    const text = await fetchAndExtract(normalized, { signal });
    signal.throwIfAborted();
    return text;
  });
}

export function resolveFetchText(ctx: VeStageContext): VeFetchTextFn {
  const parent = ctx.signal;
  const custom = ctx.fetchText;
  return (url) => (
    custom
      ? withVeDeadline('website extraction', WEBSITE_TIMEOUT_MS, parent, () => custom(url))
      : defaultFetchText(url, parent)
  ).finally(() => ctx.onActivity?.());
}

export function resolveSearch(ctx: VeStageContext): VeSearchFn {
  // Рынок проекта ведёт geo Serper только в дефолтной реализации; подменённый
  // ctx.search (тесты, особые стадии) работает как раньше.
  const parent = ctx.signal;
  return (q) => withVeDeadline('website search', SEARCH_TIMEOUT_MS, parent, (signal) => (
    ctx.search ? ctx.search(q) : defaultSearch(q, ctx.market ?? 'ru', signal)
  )).finally(() => ctx.onActivity?.());
}
