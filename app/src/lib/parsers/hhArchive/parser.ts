/**
 * HH Archive Parser — низкоуровневые функции работы с api.hh.ru/vacancies.
 *
 * Чистые функции без зависимостей от БД/воркера — чтобы можно было
 * unit-тестировать без Supabase-моков. Оркестрация (чтение конфига job'а,
 * запись результатов, прогресс) — в `runner.ts`.
 *
 * Ключевое:
 *   1. Источник — api.hh.ru (НЕ HTML-скрейп hh.ru/search/vacancy).
 *      Возвращает чистый JSON, не нужны хрупкие регекспы.
 *   2. Флаг `archived=true` — обязателен для архивных. Без него API
 *      возвращает только активные.
 *   3. Лимит 2000 на запрос — общий для всего HH (page × per_page ≤ 2000).
 *      Обходится разбиением по периодам через chunkDateRange().
 *   4. User-Agent с email — требование ToU HH. Без него возвращает 403.
 *   5. OAuth-токен — опционально. Раздвигает rate limit с общего анонимного
 *      пула до 1 RPS на токен. На сам лимит 2000 не влияет.
 */

import { buildHhRequestHeaders } from '@/lib/parsers/hhParser';

export const HH_API_BASE = 'https://api.hh.ru/vacancies';
export const HH_API_PAGE_SIZE = 100;
export const HH_API_MAX_PAGE = 19; // 19 × 100 = 1900; page=20 даёт {found:..., items:[]}
export const HH_API_RESULTS_HARD_CAP = 2000;

export type ChunkStrategy = 'single' | 'monthly' | 'weekly' | 'daily';

export interface HHParseConfig {
  searchQueries: string[];
  area: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD
  archived: boolean;
  chunkStrategy: ChunkStrategy;
  userAgent: string;
  oauthToken?: string;
  /** Задержка между запросами (мс). Default 1500 — безопасно даже без OAuth. */
  requestDelayMs?: number;
}

export interface HHVacancy {
  vacancyId: string;
  title: string;
  company: string;
  companySiteUrl: string;
  area: string;
  employerId: string;
  publishedAt: string | null;
  archivedAt: string | null;
}

export interface HHRawResponse {
  found: number;
  pages: number;
  per_page: number;
  items?: unknown[];
  errors?: { type: string }[];
}

/** Разбивает [from, to] на под-окна по выбранной стратегии. */
export function chunkDateRange(
  fromIso: string,
  toIso: string,
  strategy: ChunkStrategy,
): { from: string; to: string }[] {
  if (strategy === 'single') return [{ from: fromIso, to: toIso }];

  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) return [{ from: fromIso, to: toIso }];

  // Step size в днях
  const stepDays = strategy === 'daily' ? 1 : strategy === 'weekly' ? 7 : 30;

  const chunks: { from: string; to: string }[] = [];
  let cur = from;
  while (cur <= to) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + stepDays - 1);
    const actualEnd = chunkEnd > to ? to : chunkEnd;
    chunks.push({ from: toIsoDate(cur), to: toIsoDate(actualEnd) });
    cur = new Date(actualEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return chunks;
}

function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Парсит area-поле в массив. Поддерживает CSV ("1,2,3") и single ("113").
 * Пустые токены отсекаются, чтобы не плодить пустые `area=` параметры.
 */
export function parseAreas(area: string): string[] {
  return area
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Формирует URL запроса к api.hh.ru/vacancies.
 * Если area CSV — добавит несколько `area=` параметров (HH OR-объединит их).
 */
export function buildSearchUrl(
  config: HHParseConfig,
  query: string,
  page: number,
  dateFrom: string,
  dateTo: string,
): string {
  const params = new URLSearchParams();
  params.set('text', query);
  params.set('per_page', String(HH_API_PAGE_SIZE));
  params.set('page', String(page));
  const areas = parseAreas(config.area);
  if (areas.length === 0) params.append('area', '113');
  else for (const a of areas) params.append('area', a);
  if (config.archived) params.set('archived', 'true');
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  return `${HH_API_BASE}?${params.toString()}`;
}

/**
 * GET к HH API c автоматическими ретраями на 429/5xx.
 *
 * Ретраи только для transient ошибок:
 *   - 429 Too Many Requests → ждём Retry-After, затем повторяем
 *   - 5xx Server Error      → экспоненциальный backoff (2s/4s/8s)
 *   - network errors        → то же
 *
 * НЕ ретраим 4xx (кроме 429) — они не починятся от повтора (403, 404, 400).
 */
export async function fetchHHJson(
  url: string,
  config: Pick<HHParseConfig, 'userAgent' | 'oauthToken'>,
  signal?: AbortSignal,
  maxRetries: number = 3,
): Promise<HHRawResponse> {
  // Используем тот же auth-стек что и стандартный HH-парсер: env-переменная
  // HH_ACCESS_TOKEN (установлена на проде), default UA.
  const headers = buildHhRequestHeaders(config.userAgent);
  if (config.oauthToken) headers.Authorization = `Bearer ${config.oauthToken}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetch(url, { headers, signal });
      if (res.ok) {
        const json = (await res.json()) as HHRawResponse;
        if (json.errors?.length) {
          throw new Error(`HH API returned errors: ${JSON.stringify(json.errors)}`);
        }
        return json;
      }

      // Retryable codes
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        const backoff =
          retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 30000);
        lastErr = new Error(`HH API ${res.status}, retry ${attempt + 1}/${maxRetries} after ${backoff}ms`);
        if (attempt < maxRetries) {
          await sleep(backoff);
          continue;
        }
      }

      // Non-retryable (4xx кроме 429) — сразу throw без ретраев.
      const body = await res.text().catch(() => '');
      throw new Error(`HH API ${res.status}: ${body.slice(0, 200)}`);
    } catch (e) {
      // network error (TypeError, AbortError, etc.) — ретраим
      if (e instanceof Error && (e.name === 'AbortError' || (e as { status?: number }).status)) {
        throw e;
      }
      lastErr = e as Error;
      if (attempt < maxRetries) {
        await sleep(Math.min(2000 * 2 ** attempt, 30000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('HH API: exhausted retries');
}

/**
 * Делит [from, to] пополам по датам. Если from === to → возвращает single
 * (нечего делить — это уже минимальный 1-дневный чанк).
 */
export function splitDateRangeHalf(
  fromIso: string,
  toIso: string,
): { from: string; to: string }[] {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
    return [{ from: fromIso, to: toIso }];
  }
  const days = Math.floor((to.getTime() - from.getTime()) / 86400000);
  if (days < 1) return [{ from: fromIso, to: toIso }];
  const midOffset = Math.floor(days / 2);
  const mid = new Date(from);
  mid.setUTCDate(mid.getUTCDate() + midOffset);
  const midPlus1 = new Date(mid);
  midPlus1.setUTCDate(midPlus1.getUTCDate() + 1);
  return [
    { from: fromIso, to: mid.toISOString().slice(0, 10) },
    { from: midPlus1.toISOString().slice(0, 10), to: toIso },
  ];
}

/** Достаёт массив вакансий из ответа API в нашу типизированную форму. */
export function extractVacancies(response: HHRawResponse): HHVacancy[] {
  const items = response.items ?? [];
  const out: HHVacancy[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const employer = (v.employer as Record<string, unknown> | undefined) ?? {};
    const area = (v.area as Record<string, unknown> | undefined) ?? {};
    out.push({
      vacancyId: String(v.id ?? ''),
      title: String(v.name ?? ''),
      company: String(employer.name ?? ''),
      companySiteUrl: String(employer.site_url ?? ''),
      area: String(area.name ?? ''),
      employerId: String(employer.id ?? ''),
      publishedAt: typeof v.published_at === 'string' ? v.published_at : null,
      // HH в search-ответе не отдаёт явное archived_at, но в архиве
      // created_at != published_at — оно нам не сильно нужно, поэтому
      // просто null. Кто хочет — пусть fetch'ает /vacancies/{id}.
      archivedAt: null,
    });
  }
  return out;
}

/**
 * Тащит сайт работодателя по его id. HH /vacancies в search-ответе НЕ
 * отдаёт `employer.site_url` — только id/name/url. Чтобы получить
 * настоящий внешний сайт компании, надо отдельно дёрнуть /employers/{id}.
 *
 * Returns `null` если у работодателя сайта нет (HH вернул site_url=null
 * или пустую строку), либо если employer удалён/недоступен.
 */
export async function fetchEmployerSite(
  employerId: string,
  config: Pick<HHParseConfig, 'userAgent' | 'oauthToken'>,
  signal?: AbortSignal,
): Promise<string | null> {
  const headers = buildHhRequestHeaders(config.userAgent);
  if (config.oauthToken) headers.Authorization = `Bearer ${config.oauthToken}`;

  const res = await fetch(`https://api.hh.ru/employers/${employerId}`, { headers, signal });
  if (res.status === 404) return null; // employer удалён → не валим всё
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HH employer API ${res.status}: ${body.slice(0, 120)}`);
  }
  const json = (await res.json()) as { site_url?: string | null };
  const url = (json.site_url ?? '').trim();
  return url || null;
}

/** Утилита sleep — для requestDelayMs. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
