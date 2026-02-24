import type { Dispatcher } from 'undici';
import { ProxyAgent } from 'undici';
import { logInfo, logError } from '@/lib/loggerServer';
import type { Span } from '@/lib/tracer';

export type HHSearchConfig = {
  text?: string;
  url?: string;
  area?: string | string[];
  salary_from?: number;
  currency?: string;
  date_from?: string;
  date_to?: string;
  per_page?: number;
  params?: Record<string, string | string[]>;
  /**
   * Fetch employer details (site/description/industries).
   * When false, parsing is significantly faster.
   */
  fetch_employers?: boolean;
};

export type HHVacancy = {
  vacancy_id: string;
  name: string;
  url: string;
  salary_from?: number;
  salary_to?: number;
  salary_currency?: string;
  employer_id?: string;
  company_name: string;
  company_url?: string;
  company_site_url?: string;
  company_description?: string;
  area: string;
  industries: string[];
  published_at?: string;
};

type HHApiVacancyItem = {
  id: string;
  name: string;
  alternate_url: string;
  salary: null | { from: number | null; to: number | null; currency: string };
  employer: { id?: string | null; name: string; alternate_url: string | null };
  area: { name: string };
  published_at?: string;
};

type HHApiEmployer = {
  id: string;
  site_url?: string | null;
  description?: string | null;
  industries?: Array<{ id?: string; name?: string }>;
};

type HHApiVacanciesResponse = {
  found: number;
  pages: number;
  page: number;
  per_page: number;
  items: HHApiVacancyItem[];
};

type HHApiErrorPayload = {
  errors?: Array<{
    value?: string;
    type?: string;
    captcha_url?: string;
  }>;
  request_id?: string;
};

export class HHApiError extends Error {
  status: number;
  type?: string;
  captchaUrl?: string;
  requestId?: string;

  constructor(
    message: string,
    options: { status: number; type?: string; captchaUrl?: string; requestId?: string }
  ) {
    super(message);
    this.name = 'HHApiError';
    this.status = options.status;
    this.type = options.type;
    this.captchaUrl = options.captchaUrl;
    this.requestId = options.requestId;
  }
}

export class ParserJobCancelledError extends Error {
  constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'ParserJobCancelledError';
  }
}

export type ParserProgressStage =
  | 'pending'
  | 'partitioning'
  | 'fetching_vacancies'
  | 'fetching_employers'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled';

const HH_API_BASE = 'https://api.hh.ru';
const FOUND_LIMIT = 2000;
const MIN_REQUEST_INTERVAL_MS = (() => {
  const raw = Number(process.env.HH_REQUEST_INTERVAL_MS ?? '250');
  return Number.isFinite(raw) ? Math.max(100, raw) : 250;
})();
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.HH_MAX_CONCURRENCY ?? '2');
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
})();
const PARTITION_CONCURRENCY = (() => {
  const raw = Number(process.env.HH_PARTITION_CONCURRENCY ?? '2');
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
})();
const PARTITION_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HH_PARTITION_TIMEOUT_MS ?? '120000');
  return Number.isFinite(raw) ? Math.max(30_000, Math.floor(raw)) : 120000;
})();
const EMPLOYER_CONCURRENCY = (() => {
  const raw = Number(process.env.HH_EMPLOYER_CONCURRENCY ?? String(MAX_CONCURRENCY));
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : MAX_CONCURRENCY;
})();
const PAGE_DELAY_MS = (() => {
  const raw = Number(process.env.HH_PAGE_DELAY_MS ?? '0');
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
})();
const MAX_RETRIES = (() => {
  const raw = Number(process.env.HH_MAX_RETRIES ?? '5');
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 5;
})();
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HH_REQUEST_TIMEOUT_MS ?? '10000');
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 10000;
})();
const VACANCY_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HH_VACANCY_REQUEST_TIMEOUT_MS ?? String(REQUEST_TIMEOUT_MS));
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : REQUEST_TIMEOUT_MS;
})();
const EMPLOYER_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HH_EMPLOYER_REQUEST_TIMEOUT_MS ?? '14000');
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 14000;
})();
const PROXY_URLS = (() => {
  const urls: string[] = [];
  if (process.env.HH_PROXY_URLS) {
    try {
      const parsed = JSON.parse(process.env.HH_PROXY_URLS);
      if (Array.isArray(parsed)) {
        urls.push(...parsed.filter((u) => typeof u === 'string'));
      }
    } catch {
      // ignore
    }
  }
  if (urls.length === 0 && process.env.HH_PROXY_URL) {
    urls.push(process.env.HH_PROXY_URL.trim());
  }
  return urls;
})();

const PROXY_DISPATCHERS: Dispatcher[] = PROXY_URLS.map((url) => new ProxyAgent(url));

function getProxyDispatcher(): Dispatcher | undefined {
  if (PROXY_DISPATCHERS.length === 0) return undefined;
  const index = Math.floor(Math.random() * PROXY_DISPATCHERS.length);
  return PROXY_DISPATCHERS[index];
}

let lastRequestAt = 0;
let activeSlots = 0;
const slotQueue: Array<() => void> = [];
/** Global backoff: when a 429 is received, all requests pause until this time */
let globalBackoffUntil = 0;

type HHSearchParams = Record<string, string | string[]>;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function parseHhError(bodyText: string): { type?: string; captchaUrl?: string; requestId?: string } {
  const payload = safeJsonParse<HHApiErrorPayload>(bodyText);
  const entry =
    payload?.errors?.find((item) => item.type === 'captcha_required' || item.value === 'captcha_required') ??
    payload?.errors?.[0];
  return {
    type: entry?.type ?? entry?.value,
    captchaUrl: entry?.captcha_url,
    requestId: payload?.request_id,
  };
}

function buildHhErrorMessage(
  status: number,
  details: { type?: string; captchaUrl?: string },
  bodyText: string,
) {
  if (details.type === 'captcha_required' || details.captchaUrl) {
    const link = details.captchaUrl ? ` ${details.captchaUrl}` : '';
    return `HH API требует капчу.${link}`;
  }
  if (details.type) return `HH API error ${status}: ${details.type}`;
  if (bodyText) return `HH API error ${status}: ${bodyText}`;
  return `HH API error ${status}`;
}

async function throttleHhRequest() {
  // Wait for a free concurrency slot
  if (activeSlots >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => slotQueue.push(resolve));
  }
  activeSlots += 1;

  // Respect global backoff (e.g. after 429)
  const backoffWait = globalBackoffUntil - Date.now();
  if (backoffWait > 0) {
    await sleep(backoffWait);
  }

  // Enforce minimum interval between requests
  const now = Date.now();
  const intervalWait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - now;
  if (intervalWait > 0) {
    await sleep(intervalWait);
  }
  lastRequestAt = Date.now();

  return () => {
    activeSlots = Math.max(0, activeSlots - 1);
    const next = slotQueue.shift();
    if (next) next();
  };
}

/** Set a global backoff so all concurrent requests pause */
function setGlobalBackoff(durationMs: number) {
  const until = Date.now() + durationMs;
  if (until > globalBackoffUntil) {
    globalBackoffUntil = until;
  }
}

function toISODate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISODate(dateStr: string): Date | null {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

function midDate(a: Date, b: Date): Date {
  const t = Math.floor((a.getTime() + b.getTime()) / 2);
  const mid = new Date(t);
  mid.setHours(0, 0, 0, 0);
  return mid;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next;
}

function normalizeExtraParams(params?: HHSearchParams): HHSearchParams | undefined {
  if (!params) return undefined;
  const cleaned: HHSearchParams = {};

  for (const [key, value] of Object.entries(params)) {
    if (!key) continue;
    if (Array.isArray(value)) {
      const items = value.map((item) => String(item).trim()).filter(Boolean);
      if (items.length === 1) cleaned[key] = items[0];
      else if (items.length > 1) cleaned[key] = items;
      continue;
    }
    const trimmed = String(value).trim();
    if (trimmed) cleaned[key] = trimmed;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function parseHhSearchUrl(url: string): HHSearchConfig {
  const urlObj = new URL(url);
  const params = urlObj.searchParams;

  const config: HHSearchConfig = {
    text: params.get('text') || '',
    area: params.getAll('area'),
    date_from: params.get('date_from') || undefined,
    date_to: params.get('date_to') || undefined,
    // Add any other parameters you want to extract from the URL
    params: {},
  };

  // Populate generic params from the URL that are not directly mapped to HHSearchConfig fields
  for (const [key, value] of params.entries()) {
    if (!(key in config)) { // Avoid overwriting already mapped fields
      const existing = config.params![key];
      if (existing) {
        if (Array.isArray(existing)) {
          (existing as string[]).push(value);
        } else {
          config.params![key] = [existing as string, value];
        }
      } else {
        config.params![key] = value;
      }
    }
  }

  return normalizeSearchParams(config);
}

function getParamValues(params: HHSearchParams | undefined, key: string): string[] {
  if (!params) return [];
  const value = params[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function getParamString(params: HHSearchParams | undefined, key: string): string | undefined {
  const values = getParamValues(params, key).map((item) => item.trim()).filter(Boolean);
  return values[0];
}

function getParamNumber(params: HHSearchParams | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = getParamString(params, key);
    if (!value) continue;
    const normalized = value.replace(/\s/g, '');
    const num = Number(normalized);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function getParamArea(params: HHSearchParams | undefined): string | string[] | undefined {
  const values = getParamValues(params, 'area')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function appendExtraParams(params: URLSearchParams, extras?: HHSearchParams) {
  if (!extras) return;
  for (const [key, value] of Object.entries(extras)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    params.append(key, String(value));
  }
}

export function normalizeSearchParams(config: HHSearchConfig): HHSearchConfig {
  const params = normalizeExtraParams(config.params);
  const next: HHSearchConfig = { ...config, params };

  if (typeof next.text === 'string') next.text = next.text.trim();
  if (!next.text) next.text = getParamString(params, 'text') ?? '';
  if (!next.text) next.text = '';

  if (Array.isArray(next.area)) {
    const cleaned = next.area.map((a) => a.trim()).filter(Boolean);
    next.area = cleaned.length > 0 ? cleaned : undefined;
  } else if (typeof next.area === 'string') {
    const cleaned = next.area.trim();
    next.area = cleaned ? cleaned : undefined;
  }
  if (next.area === undefined) {
    next.area = getParamArea(params);
  }

  if (next.salary_from === undefined) {
    next.salary_from = getParamNumber(params, ['salary', 'salary_from']);
  }

  if (typeof next.currency === 'string') {
    const cleaned = next.currency.trim();
    next.currency = cleaned ? cleaned : undefined;
  }
  if (!next.currency) {
    const currency = getParamString(params, 'currency');
    if (currency) next.currency = currency;
  }

  if (!next.date_from) {
    const dateFrom = getParamString(params, 'date_from');
    if (dateFrom) next.date_from = dateFrom;
  }

  if (!next.date_to) {
    const dateTo = getParamString(params, 'date_to');
    if (dateTo) next.date_to = dateTo;
  }

  if (next.per_page === undefined) {
    next.per_page = getParamNumber(params, ['per_page', 'items_on_page']);
  }
  if (next.per_page !== undefined) {
    next.per_page = Math.max(1, Math.min(100, next.per_page));
  }

  return next;
}

function buildVacanciesUrl(config: HHSearchConfig, page: number): string {
  const params = new URLSearchParams();
  appendExtraParams(params, config.params);

  if (config.text) {
    params.delete('text');
    params.set('text', config.text);
  }

  if (config.salary_from !== undefined) {
    params.delete('salary');
    params.delete('salary_from');
    params.set('salary', String(config.salary_from));
  }

  if (config.currency) {
    params.delete('currency');
    params.set('currency', config.currency);
  }

  if (config.date_from) {
    params.delete('date_from');
    params.set('date_from', config.date_from);
  }

  if (config.date_to) {
    params.delete('date_to');
    params.set('date_to', config.date_to);
  }

  if (Array.isArray(config.area)) {
    params.delete('area');
    for (const a of config.area) params.append('area', a);
  } else if (config.area) {
    params.delete('area');
    params.set('area', config.area);
  }

  const perPage = config.per_page;
  if (perPage !== undefined) {
    params.delete('per_page');
    params.delete('items_on_page');
    params.set('per_page', String(perPage));
  } else if (!params.has('per_page') && !params.has('items_on_page')) {
    params.set('per_page', '50');
  }

  params.delete('page');
  params.set('page', String(page));

  return `${HH_API_BASE}/vacancies?${params.toString()}`;
}

export async function fetchWithRetry<T>(
  url: string,
  opts?: { maxRetries?: number; minDelayMs?: number; maxDelayMs?: number; timeoutMs?: number }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;
  const minDelayMs = opts?.minDelayMs ?? 500;
  const maxDelayMs = opts?.maxDelayMs ?? 20_000;
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let release: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      release = await throttleHhRequest();
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        headers: {
          'User-Agent': 'Portal/1.0 (HH parser)',
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
        ...(PROXY_DISPATCHERS.length > 0 ? { dispatcher: getProxyDispatcher() } : {}),
      };
      const res = await fetch(url, fetchInit);

      if (res.ok) {
        const bodyText = await res.text().catch(() => '');
        const parsed = safeJsonParse<T>(bodyText);
        if (parsed) return parsed;
        const requestId = res.headers.get('x-request-id') ?? res.headers.get('x-hh-request-id') ?? undefined;
        throw new HHApiError('HH API returned non-JSON response', {
          status: res.status,
          type: 'invalid_response',
          requestId,
        });
      }

      const retryAfter = res.headers.get('retry-after');
      const retryAfterMsRaw = retryAfter ? Number(retryAfter) * 1000 : null;
      const retryAfterMs = retryAfterMsRaw != null && Number.isFinite(retryAfterMsRaw)
        ? Math.min(retryAfterMsRaw, maxDelayMs)
        : null;

      const shouldRetry = res.status === 429 || res.status === 403 || (res.status >= 500 && res.status <= 599);
      if (!shouldRetry) {
        const bodyText = await res.text().catch(() => '');
        const details = parseHhError(bodyText);
        const message = buildHhErrorMessage(res.status, details, bodyText);
        throw new HHApiError(message, {
          status: res.status,
          type: details.type,
          captchaUrl: details.captchaUrl,
          requestId: details.requestId,
        });
      }

      // On 429/403 set global backoff so ALL concurrent requests also pause
      if (res.status === 429 || res.status === 403) {
        const backoff = retryAfterMs ?? Math.min(maxDelayMs, minDelayMs * 2 ** (attempt + 2));
        setGlobalBackoff(backoff);
      }

      const base = retryAfterMs ?? Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
      continue;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error('HH API request timed out');
      } else {
        lastError = err;
      }
      if (attempt === maxRetries) break;
      const base = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (release) release();
    }
  }

  throw lastError instanceof Error ? lastError : new Error('HH API request failed');
}

async function fetchFound(config: HHSearchConfig, trace?: Span | null, label?: string): Promise<number> {
  const url = buildVacanciesUrl({ ...config, per_page: 1 }, 0);
  const span = await trace?.startChild({
    name: 'hh.fetch_found',
    input: { url, text: config.text, area: config.area, date_from: config.date_from, date_to: config.date_to },
    message: label ?? 'Проверка количества вакансий',
  });
  try {
    const data = await fetchWithRetry<HHApiVacanciesResponse>(url, {
      timeoutMs: VACANCY_REQUEST_TIMEOUT_MS,
    });
    const found = data.found ?? 0;
    await span?.end({ found }, `Найдено ${found}`);
    return found;
  } catch (err) {
    await span?.fail(err);
    throw err;
  }
}

function normalizeIndustries(items?: Array<{ id?: string; name?: string }>): string[] {
  if (!items || items.length === 0) return [];
  return items.map((item) => item?.name).filter((name): name is string => Boolean(name));
}

function stripHtml(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const withSpaces = raw.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  const withoutTags = withSpaces.replace(/<[^>]*>/g, ' ');
  const decoded = withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const normalized = decoded.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

async function fetchEmployerDetails(
  employerId: string,
): Promise<{ siteUrl?: string; industries?: string[]; description?: string }> {
  const url = `${HH_API_BASE}/employers/${employerId}`;
  const data = await fetchWithRetry<HHApiEmployer>(url, {
    timeoutMs: EMPLOYER_REQUEST_TIMEOUT_MS,
  });
  return {
    siteUrl: data.site_url ?? undefined,
    industries: normalizeIndustries(data.industries),
    description: stripHtml(data.description),
  };
}

export async function partitionQuery(config: HHSearchConfig, trace?: Span | null): Promise<HHSearchConfig[]> {
  const normalized = normalizeSearchParams(config);
  const found = await fetchFound(normalized, trace);
  if (found <= FOUND_LIMIT) return [normalized];

  const dateFrom = normalized.date_from ? parseISODate(normalized.date_from) : null;
  const dateTo = normalized.date_to ? parseISODate(normalized.date_to) : null;

  if (dateFrom && dateTo && dateFrom < dateTo) {
    return partitionByDate(normalized, dateFrom, dateTo, 0, trace);
  }

  const fallback = await partitionFallback(normalized);
  return fallback.length > 0 ? fallback : [normalized];
}

async function partitionByDate(
  config: HHSearchConfig,
  from: Date,
  to: Date,
  depth: number,
  trace?: Span | null,
): Promise<HHSearchConfig[]> {
  if (depth >= 14) return [config];

  const fromISO = toISODate(from);
  const toISO = toISODate(to);
  const current = { ...config, date_from: fromISO, date_to: toISO };
  const found = await fetchFound(current, trace, `Проверка диапазона ${fromISO} → ${toISO}`);
  if (found <= FOUND_LIMIT) return [current];

  const mid = midDate(from, to);
  const rightFrom = addDays(mid, 1);
  if (mid <= from || rightFrom > to) {
    const fallback = await partitionFallback(current);
    return fallback.length > 0 ? fallback : [current];
  }

  const left: HHSearchConfig = { ...config, date_from: fromISO, date_to: toISODate(mid) };
  const right: HHSearchConfig = { ...config, date_from: toISODate(rightFrom), date_to: toISO };

  const [leftFound, rightFound] = await Promise.all([
    fetchFound(left, trace, `Левая половина ${left.date_from} → ${left.date_to}`),
    fetchFound(right, trace, `Правая половина ${right.date_from} → ${right.date_to}`),
  ]);
  if (leftFound === found && rightFound === found) {
    const fallback = await partitionFallback(current, false);
    return fallback.length > 0 ? fallback : [current];
  }

  const [leftParts, rightParts] = await Promise.all([
    leftFound > FOUND_LIMIT ? partitionByDate(left, from, mid, depth + 1, trace) : [{ ...left }],
    rightFound > FOUND_LIMIT ? partitionByDate(right, mid, to, depth + 1, trace) : [{ ...right }],
  ]);

  return [...leftParts, ...rightParts];
}

async function partitionFallback(config: HHSearchConfig, allowDateFallback = true): Promise<HHSearchConfig[]> {
  if (Array.isArray(config.area) && config.area.length > 1) {
    const mid = Math.ceil(config.area.length / 2);
    const left = config.area.slice(0, mid);
    const right = config.area.slice(mid);
    const parts: HHSearchConfig[] = [];
    if (left.length) parts.push({ ...config, area: left });
    if (right.length) parts.push({ ...config, area: right });
    return parts;
  }

  if (config.text?.includes('|')) {
    const parts = config.text
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts.map((t) => ({ ...config, text: t }));
  }

  if (allowDateFallback && !config.date_from && !config.date_to) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(today);
    from.setDate(from.getDate() - 30);

    const withDates: HHSearchConfig = {
      ...config,
      date_from: toISODate(from),
      date_to: toISODate(today),
    };

    const dateFrom = withDates.date_from ? parseISODate(withDates.date_from) : null;
    const dateTo = withDates.date_to ? parseISODate(withDates.date_to) : null;
    if (dateFrom && dateTo && dateFrom < dateTo) {
      return partitionByDate(withDates, dateFrom, dateTo, 0);
    }
  }

  return [];
}

function mapVacancy(item: HHApiVacancyItem): HHVacancy {
  const salary_from = item.salary?.from ?? undefined;
  const salary_to = item.salary?.to ?? undefined;
  const salary_currency = item.salary?.currency ?? undefined;

  return {
    vacancy_id: item.id,
    name: item.name,
    url: item.alternate_url,
    salary_from: salary_from ?? undefined,
    salary_to: salary_to ?? undefined,
    salary_currency,
    employer_id: item.employer?.id ?? undefined,
    company_name: item.employer?.name ?? '',
    company_url: item.employer?.alternate_url ?? undefined,
    area: item.area?.name ?? '',
    industries: [],
    published_at: item.published_at,
  };
}

type FetchVacanciesOptions = {
  jobId?: string;
  searchText?: string;
  shouldCancel?: () => Promise<boolean> | boolean;
  cancelCheckIntervalMs?: number;
  onProgress?: (progress: FetchVacanciesProgress) => void;
  progressIntervalMs?: number;
  onStage?: (stage: ParserProgressStage) => void;
  trace?: Span | null;
  logMeta?: {
    userId?: string | null;
    requestId?: string | null;
    route?: string | null;
    ip?: string | null;
  };
};

type FetchVacanciesProgress = {
  found?: number;
  parsed?: number;
  fetched?: number;
  employersTotal?: number;
  employersFetched?: number;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export async function fetchVacancies(
  configOrUrl: HHSearchConfig | string,
  options?: FetchVacanciesOptions,
): Promise<{ found: number; vacancies: HHVacancy[] }> {
  const cancelInterval = options?.cancelCheckIntervalMs ?? 5000;
  const progressInterval = options?.progressIntervalMs ?? 2000;
  let lastCancelCheck = 0;
  let lastProgressAt = 0;
  const checkCancelled = async () => {
    if (!options?.shouldCancel) return;
    const now = Date.now();
    if (now - lastCancelCheck < cancelInterval) return;
    lastCancelCheck = now;
    const cancelled = await options.shouldCancel();
    if (cancelled) {
      throw new ParserJobCancelledError();
    }
  };
  const reportProgress = (payload: FetchVacanciesProgress, force = false) => {
    if (!options?.onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < progressInterval) return;
    lastProgressAt = now;
    options.onProgress(payload);
  };

  const normalized = typeof configOrUrl === 'string' ? normalizeSearchParams(parseHhSearchUrl(configOrUrl)) : normalizeSearchParams(configOrUrl);
  const shouldFetchEmployers = normalized.fetch_employers !== false;
  options?.onStage?.('partitioning');
  const partitionSpan = await options?.trace?.startChild({
    name: 'hh.partition_query',
    input: {
      text: normalized.text,
      area: normalized.area,
      date_from: normalized.date_from,
      date_to: normalized.date_to,
    },
    message: 'Подготовка разбиения запроса',
  });
  let partitions: HHSearchConfig[];
  try {
    partitions = await withTimeout(
      partitionQuery(normalized, options?.trace),
      PARTITION_TIMEOUT_MS,
      () =>
        new HHApiError('HH partitioning timed out', {
          status: 0,
          type: 'partition_timeout',
        }),
    );
    await partitionSpan?.end({ count: partitions.length }, `Подготовлено ${partitions.length} разбиений`);
  } catch (err) {
    await partitionSpan?.fail(err);
    throw err;
  }
  options?.onStage?.('fetching_vacancies');
  void logInfo(
    'parser.hh.partitions',
    'HH partitions prepared',
    {
      jobId: options?.jobId,
      searchText: options?.searchText ?? normalized.text,
      count: partitions.length,
      text: normalized.text,
      area: normalized.area,
      fetch_employers: shouldFetchEmployers,
    },
    options?.logMeta,
  );

  await checkCancelled();

  const uniqueVacancies = new Map<string, HHVacancy>();
  let totalFound = 0;
  let totalFoundRaw = 0;
  let fetchedCount = 0;

  const registerItems = (items?: HHApiVacancyItem[]) => {
    if (!items || items.length === 0) return;
    for (const item of items) {
      fetchedCount += 1;
      const vacancy = mapVacancy(item);
      const existing = uniqueVacancies.get(vacancy.vacancy_id);
      if (!existing) {
        uniqueVacancies.set(vacancy.vacancy_id, vacancy);
      } else {
        uniqueVacancies.set(vacancy.vacancy_id, { ...existing, ...vacancy });
      }
    }
    reportProgress({ found: totalFound, parsed: uniqueVacancies.size, fetched: fetchedCount });
  };

  let partitionErrors = 0;

  await mapWithConcurrency(
    partitions,
    PARTITION_CONCURRENCY,
    async (part, index) => {
      await checkCancelled();
      const partSpan = await options?.trace?.startChild({
        name: 'hh.partition',
        input: { index: index + 1, total: partitions.length, part },
        message: `Разбиение ${index + 1}/${partitions.length}`,
      });
      void logInfo(
        'parser.hh.partition.start',
        'HH partition started',
        {
          jobId: options?.jobId,
          searchText: options?.searchText ?? normalized.text,
          index: index + 1,
          total: partitions.length,
          part,
        },
        options?.logMeta,
      );

      try {
        let partitionCollected = 0;
        const firstUrl = buildVacanciesUrl(part, 0);
        const first = await fetchWithRetry<HHApiVacanciesResponse>(firstUrl, {
          timeoutMs: VACANCY_REQUEST_TIMEOUT_MS,
        });
        const partFound = first.found ?? 0;
        const partFoundCapped = Math.min(partFound, FOUND_LIMIT);
        totalFoundRaw += partFound;
        totalFound += partFoundCapped;
        registerItems(first.items);
        partitionCollected += first.items?.length ?? 0;
        reportProgress({ found: totalFound, parsed: uniqueVacancies.size, fetched: fetchedCount });

        const totalPages = Math.min(first.pages ?? 0, Math.ceil(FOUND_LIMIT / (part.per_page ?? 50)));
        if (partFound > FOUND_LIMIT) {
          void logInfo(
            'parser.hh.partition.capped',
            'HH partition capped by limit',
            {
              jobId: options?.jobId,
              searchText: options?.searchText ?? normalized.text,
              index: index + 1,
              found: partFound,
              cappedTo: partFoundCapped,
            },
            options?.logMeta,
          );
        }
        for (let page = 1; page < totalPages; page++) {
          if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
          await checkCancelled();
          try {
            const url = buildVacanciesUrl(part, page);
            const data = await fetchWithRetry<HHApiVacanciesResponse>(url, {
              timeoutMs: VACANCY_REQUEST_TIMEOUT_MS,
            });
            registerItems(data.items);
            partitionCollected += data.items?.length ?? 0;
          } catch (pageErr) {
            // Log page error but continue with next pages
            if (pageErr instanceof ParserJobCancelledError) throw pageErr;
            void logError(
              'parser.hh.partition.page.failed',
              pageErr,
              {
                jobId: options?.jobId,
                searchText: options?.searchText ?? normalized.text,
                index: index + 1,
                page: page + 1,
                totalPages,
              },
              options?.logMeta,
            );
            // If it's a captcha error, stop this partition entirely
            if (pageErr instanceof HHApiError && pageErr.captchaUrl) break;
          }
          if (page === totalPages - 1 || page % 5 === 0) {
            void logInfo(
              'parser.hh.partition.progress',
              'HH partition progress',
              {
                jobId: options?.jobId,
                searchText: options?.searchText ?? normalized.text,
                index: index + 1,
                page: page + 1,
                totalPages,
                totalCollected: partitionCollected,
                parsed: uniqueVacancies.size,
              },
              options?.logMeta,
            );
          }
        }
        void logInfo(
          'parser.hh.partition.completed',
          'HH partition completed',
          {
            jobId: options?.jobId,
            searchText: options?.searchText ?? normalized.text,
            index: index + 1,
            total: partitions.length,
            parsed: uniqueVacancies.size,
            found: partFoundCapped,
            found_raw: partFound,
          },
          options?.logMeta,
        );
        await partSpan?.end(
          { found: partFoundCapped, found_raw: partFound, fetched: partitionCollected, pages: totalPages },
          `Разбиение ${index + 1}: ${partitionCollected} вакансий`,
        );
      } catch (partErr) {
        await partSpan?.fail(partErr);
        // Re-throw cancellation
        if (partErr instanceof ParserJobCancelledError) throw partErr;

        // Log and continue — one failed partition shouldn't kill the whole job
        partitionErrors += 1;
        void logError(
          'parser.hh.partition.failed',
          partErr,
          {
            jobId: options?.jobId,
            searchText: options?.searchText ?? normalized.text,
            index: index + 1,
            total: partitions.length,
            collected: uniqueVacancies.size,
          },
          options?.logMeta,
        );
      }
    },
  );

  // If ALL partitions failed and we got nothing, throw the error
  if (uniqueVacancies.size === 0 && partitionErrors > 0) {
    throw new HHApiError(
      `Все ${partitionErrors} партиций завершились с ошибками`,
      { status: 0 },
    );
  }

  const all = Array.from(uniqueVacancies.values());

  const employerIds = Array.from(
    new Set(all.map((item) => item.employer_id).filter((id): id is string => Boolean(id))),
  );

  if (employerIds.length > 0 && shouldFetchEmployers) {
    await checkCancelled();
    options?.onStage?.('fetching_employers');
    reportProgress({ employersTotal: employerIds.length, employersFetched: 0 }, true);
    void logInfo(
      'parser.hh.employers.fetch.start',
      'HH employers fetch started',
      {
        jobId: options?.jobId,
        searchText: options?.searchText ?? normalized.text,
        count: employerIds.length,
      },
      options?.logMeta,
    );
    const employerCache = new Map<string, { siteUrl?: string; industries?: string[]; description?: string }>();
    let processed = 0;
    await mapWithConcurrency(
      employerIds,
      EMPLOYER_CONCURRENCY,
      async (employerId) => {
        await checkCancelled();
        try {
          const info = await fetchEmployerDetails(employerId);
          employerCache.set(employerId, info);
        } catch {
          employerCache.set(employerId, {});
        } finally {
          processed += 1;
          reportProgress(
            { employersTotal: employerIds.length, employersFetched: processed },
            processed === employerIds.length,
          );
          if (processed % 50 === 0 || processed === employerIds.length) {
            void logInfo(
              'parser.hh.employers.fetch.progress',
              'HH employers fetch progress',
              {
                jobId: options?.jobId,
                searchText: options?.searchText ?? normalized.text,
                fetched: processed,
                total: employerIds.length,
              },
              options?.logMeta,
            );
          }
        }
        return null;
      },
    );

    for (const vacancy of all) {
      if (!vacancy.employer_id) continue;
      const info = employerCache.get(vacancy.employer_id);
      if (!info) continue;
      if (info.siteUrl) vacancy.company_site_url = info.siteUrl;
      if (info.industries && info.industries.length > 0) {
        vacancy.industries = info.industries;
      }
      if (info.description) vacancy.company_description = info.description;
    }
  } else {
    reportProgress({ employersTotal: 0, employersFetched: 0 }, true);
    if (!shouldFetchEmployers) {
      void logInfo(
        'parser.hh.employers.fetch.skipped',
        'HH employers fetch skipped',
        {
          jobId: options?.jobId,
          searchText: options?.searchText ?? normalized.text,
          count: employerIds.length,
        },
        options?.logMeta,
      );
    }
  }

  reportProgress({ found: totalFound, parsed: all.length, fetched: fetchedCount }, true);
  if (totalFoundRaw > totalFound) {
    void logInfo(
      'parser.hh.found.capped',
      'HH total found capped by limit',
      { jobId: options?.jobId, searchText: options?.searchText ?? normalized.text, found_raw: totalFoundRaw, found: totalFound },
      options?.logMeta,
    );
  }
  return { found: totalFound, vacancies: all };
}

