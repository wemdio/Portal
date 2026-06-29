import type { Dispatcher } from 'undici';
import { ProxyAgent } from 'undici';
import { logInfo, logWarn, logError } from '@/lib/loggerServer';
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
  /** Regional subdomain extracted from URL, e.g. "spb" from spb.hh.ru */
  subdomain?: string;
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
  description?: string;
  errors?: Array<{
    description?: string;
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

/** Parse env var as number; treats empty string the same as missing (falls back to default). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Build HTTP headers for HH API requests.
 *
 * Adds `Authorization: Bearer ${HH_ACCESS_TOKEN}` when the env var is set
 * (non-empty after trim). HH API requires OAuth for /vacancies and /employers
 * since 2026-04-15; reference endpoints (/areas, /dictionaries) still work
 * without it, so the header is intentionally optional.
 *
 * @param userAgent  Optional custom User-Agent string (e.g. for non-parser
 *                   call sites that want to identify themselves separately
 *                   in HH access logs). Falls back to the default parser UA
 *                   when omitted or empty.
 */
export function buildHhRequestHeaders(userAgent?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': userAgent && userAgent.length > 0 ? userAgent : 'Portal/1.0 (HH parser)',
    Accept: 'application/json',
  };
  const token = process.env.HH_ACCESS_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

const MIN_REQUEST_INTERVAL_MS = Math.max(100, envInt('HH_REQUEST_INTERVAL_MS', 350));
const MAX_CONCURRENCY = Math.max(1, envInt('HH_MAX_CONCURRENCY', 2));
const PARTITION_CONCURRENCY = Math.max(1, envInt('HH_PARTITION_CONCURRENCY', 2));
const PARTITION_TIMEOUT_MS = Math.max(30_000, envInt('HH_PARTITION_TIMEOUT_MS', 300_000));
const EMPLOYER_CONCURRENCY = Math.max(1, envInt('HH_EMPLOYER_CONCURRENCY', MAX_CONCURRENCY));
const PAGE_DELAY_MS = Math.max(0, envInt('HH_PAGE_DELAY_MS', 200));
const MAX_RETRIES = Math.max(0, envInt('HH_MAX_RETRIES', 5));
const REQUEST_TIMEOUT_MS = Math.max(1000, envInt('HH_REQUEST_TIMEOUT_MS', 30_000));
const VACANCY_REQUEST_TIMEOUT_MS = Math.max(1000, envInt('HH_VACANCY_REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS));
const EMPLOYER_REQUEST_TIMEOUT_MS = Math.max(1000, envInt('HH_EMPLOYER_REQUEST_TIMEOUT_MS', 30_000));
const EMPLOYER_DELAY_MS = Math.max(0, envInt('HH_EMPLOYER_DELAY_MS', 100));
const PROXY_URLS = (() => {
  const urls: string[] = [];
  if (process.env.PROXY_URLS) {
    try {
      const parsed = JSON.parse(process.env.PROXY_URLS);
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

type ProxyEntry = {
  url: string;
  dispatcher: Dispatcher;
  failedAt: number;
  consecutiveFailures: number;
};

const PROXY_COOLDOWN_MS = 60_000;
const PROXY_MAX_CONSECUTIVE_FAILURES = 3;

const PROXY_ENTRIES: ProxyEntry[] = PROXY_URLS.map((url) => ({
  url,
  dispatcher: new ProxyAgent(url),
  failedAt: 0,
  consecutiveFailures: 0,
}));

function isProxyConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: Error & { code?: string } }).cause;
  const code = cause?.code ?? '';
  const msg = err.message + (cause?.message ?? '');
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT')
  );
}

function getHealthyProxies(): ProxyEntry[] {
  const now = Date.now();
  return PROXY_ENTRIES.filter(
    (p) =>
      p.consecutiveFailures < PROXY_MAX_CONSECUTIVE_FAILURES ||
      now - p.failedAt > PROXY_COOLDOWN_MS,
  );
}

let proxyRoundRobinIndex = 0;

function getProxyDispatcher(exclude?: ProxyEntry): { entry: ProxyEntry; dispatcher: Dispatcher } | undefined {
  if (PROXY_ENTRIES.length === 0) return undefined;
  let candidates = getHealthyProxies().filter((p) => p !== exclude);
  if (candidates.length === 0) {
    candidates = PROXY_ENTRIES.filter((p) => p !== exclude);
  }
  if (candidates.length === 0) {
    candidates = PROXY_ENTRIES;
  }
  proxyRoundRobinIndex += 1;
  const idx = proxyRoundRobinIndex % candidates.length;
  const entry = candidates[idx];
  return { entry, dispatcher: entry.dispatcher };
}

function markProxyFailed(entry: ProxyEntry) {
  entry.failedAt = Date.now();
  entry.consecutiveFailures += 1;
}

function markProxySuccess(entry: ProxyEntry) {
  entry.consecutiveFailures = 0;
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

/** Extract network cause from fetch/undici errors for clearer logs and user-facing messages */
function getFetchFailureReason(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) {
    const c = err.cause as Error & { code?: string };
    const code = c.code ?? '';
    const msg = c.message ?? '';
    if (code) return `${code}: ${msg}`.trim();
    return msg || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
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

function parseHhError(bodyText: string): {
  type?: string;
  value?: string;
  description?: string;
  captchaUrl?: string;
  requestId?: string;
} {
  const payload = safeJsonParse<HHApiErrorPayload>(bodyText);
  const entry =
    payload?.errors?.find((item) => item.type === 'captcha_required' || item.value === 'captcha_required') ??
    payload?.errors?.[0];
  return {
    type: entry?.type,
    value: entry?.value,
    description: entry?.description ?? payload?.description,
    captchaUrl: entry?.captcha_url,
    requestId: payload?.request_id,
  };
}

function extractRequestId(headers: Headers, fallback?: string): string | undefined {
  return fallback ?? headers.get('x-request-id') ?? headers.get('x-hh-request-id') ?? undefined;
}

function buildHhErrorMessage(
  status: number,
  details: { type?: string; value?: string; captchaUrl?: string; requestId?: string; description?: string },
  bodyText: string,
) {
  const requestSuffix = details.requestId ? ` (request_id: ${details.requestId})` : '';

  if (details.type === 'captcha_required' || details.captchaUrl) {
    const link = details.captchaUrl ? ` ${details.captchaUrl}` : '';
    return `HH API требует капчу.${link}${requestSuffix}`;
  }
  if (status === 403 && details.type === 'oauth') {
    const oauthReason = details.value ? ` (${details.value})` : '';
    return `HH API OAuth ошибка 403${oauthReason}${requestSuffix}`;
  }
  if (status === 403 && (details.type === 'forbidden' || !details.type)) {
    return `HH API отклонил запрос (403 forbidden, вероятен anti-bot/IP блок)${requestSuffix}`;
  }
  if (details.type || details.value) return `HH API error ${status}: ${details.type ?? details.value}${requestSuffix}`;
  if (details.description) return `HH API error ${status}: ${details.description}${requestSuffix}`;
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

const HH_API_VALID_PARAMS = new Set([
  'text',
  'excluded_text',
  'search_field',
  'experience',
  'employment',
  'schedule',
  // HH renamed the remote/on-site filter from `schedule=remote` to
  // `work_format=REMOTE|ON_SITE|HYBRID|FIELD_WORK`. Without this the
  // copied search URL's remote filter was silently dropped and the parser
  // returned all on-site jobs too (10k vs ~2.7k on the site).
  'work_format',
  'area',
  'metro',
  'professional_role',
  'industry',
  'employer_id',
  'currency',
  'salary',
  'label',
  'only_with_salary',
  'period',
  'date_from',
  'date_to',
  'top_lat',
  'bottom_lat',
  'left_lng',
  'right_lng',
  'order_by',
  'sort_point_lat',
  'sort_point_lng',
  'clusters',
  'describe_arguments',
  'per_page',
  'page',
  'no_magic',
  'premium',
  'responses_count_enabled',
  'part_time',
  'accept_temporary',
  'locale',
  'host',
]);

// HH web-search URLs also carry params we intentionally do NOT forward to the
// API: pure UI/analytics chrome, or values we remap ourselves (currency_code ->
// currency, items_on_page -> per_page). These are expected drops — no warning.
const HH_IGNORED_WEB_PARAMS = new Set([
  'ored_clusters',
  'enable_snippets',
  'salary_mode',
  'currency_code',
  'items_on_page',
  'suggestId',
  'suggest_id',
  'hhtmFrom',
  'hhtmFromLabel',
  'from',
  'disableBrowserCache',
  'forceFiltersSaving',
  'searchSessionId',
  'search_session_id',
  'L_save_area',
  'customDomain',
]);

// Warn at most once per process per unknown param, so a future HH rename (like
// schedule -> work_format) surfaces in the logs instead of silently dropping a
// filter and inflating result counts.
const warnedDroppedHhParams = new Set<string>();

const HH_NOOP_VALUES: Record<string, Set<string>> = {
  experience: new Set(['doesNotMatter']),
  order_by: new Set(['']),
};

function isNoopValue(key: string, value: string): boolean {
  return HH_NOOP_VALUES[key]?.has(value) ?? false;
}

function normalizeExtraParams(params?: HHSearchParams): HHSearchParams | undefined {
  if (!params) return undefined;
  const cleaned: HHSearchParams = {};

  for (const [key, value] of Object.entries(params)) {
    if (!key) continue;
    if (!HH_API_VALID_PARAMS.has(key)) {
      if (!HH_IGNORED_WEB_PARAMS.has(key) && !warnedDroppedHhParams.has(key)) {
        warnedDroppedHhParams.add(key);
        const sample = Array.isArray(value) ? value.join(', ') : String(value);
        void logWarn(
          'parser.hh.dropped_param',
          `HH search param "${key}" is not in HH_API_VALID_PARAMS and was dropped before the API call; if HH added or renamed a filter, add it to the allowlist`,
          { param: key, sample: sample.slice(0, 200) },
        );
      }
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => String(item).trim()).filter((v) => v && !isNoopValue(key, v));
      if (items.length === 1) cleaned[key] = items[0];
      else if (items.length > 1) cleaned[key] = items;
      continue;
    }
    const trimmed = String(value).trim();
    if (!trimmed || isNoopValue(key, trimmed)) continue;
    cleaned[key] = trimmed;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function extractHhSubdomain(hostname: string): string | undefined {
  const match = hostname.match(/^(.+)\.hh\.ru$/i);
  return match ? match[1].toLowerCase() : undefined;
}

export function parseHhSearchUrl(url: string): HHSearchConfig {
  const urlObj = new URL(url);
  const params = urlObj.searchParams;

  const config: HHSearchConfig = {
    text: params.get('text') || '',
    area: params.getAll('area'),
    date_from: params.get('date_from') || undefined,
    date_to: params.get('date_to') || undefined,
    subdomain: extractHhSubdomain(urlObj.hostname),
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
  const rawParams = config.params;
  const params = normalizeExtraParams(rawParams);
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
    const currency = getParamString(params, 'currency') ?? getParamString(rawParams, 'currency_code');
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
    next.per_page = getParamNumber(params, ['per_page']) ?? getParamNumber(rawParams, ['items_on_page']);
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
  let lastProxyEntry: ProxyEntry | undefined;

  // Diagnostic counters for clear error messages
  let count403 = 0;
  let count429 = 0;
  let count5xx = 0;
  let countTimeout = 0;
  let countProxyFail = 0;
  let countCaptcha = 0;
  let countOauth403 = 0;
  let countAntiBot403 = 0;
  let lastStatus = 0;
  let lastCaptchaUrl: string | undefined;
  let lastRequestId: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let release: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let currentProxy: ProxyEntry | undefined;
    try {
      release = await throttleHhRequest();
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const proxyResult = PROXY_ENTRIES.length > 0 ? getProxyDispatcher(lastProxyEntry) : undefined;
      currentProxy = proxyResult?.entry;

      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        headers: buildHhRequestHeaders(),
        cache: 'no-store',
        signal: controller.signal,
        ...(proxyResult ? { dispatcher: proxyResult.dispatcher } : {}),
      };
      const res = await fetch(url, fetchInit);

      if (currentProxy) markProxySuccess(currentProxy);

      if (res.ok) {
        const bodyText = await res.text().catch(() => '');
        const parsed = safeJsonParse<T>(bodyText);
        if (parsed) return parsed;
        const requestId = extractRequestId(res.headers);
        throw new HHApiError('HH API returned non-JSON response', {
          status: res.status,
          type: 'invalid_response',
          requestId,
        });
      }

      lastStatus = res.status;
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMsRaw = retryAfter ? Number(retryAfter) * 1000 : null;
      const retryAfterMs = retryAfterMsRaw != null && Number.isFinite(retryAfterMsRaw)
        ? Math.min(retryAfterMsRaw, maxDelayMs)
        : null;

      const shouldRetry = res.status === 429 || res.status === 403 || (res.status >= 500 && res.status <= 599);
      if (!shouldRetry) {
        const bodyText = await res.text().catch(() => '');
        const details = parseHhError(bodyText);
        details.requestId = extractRequestId(res.headers, details.requestId);
        const message = buildHhErrorMessage(res.status, details, bodyText);
        throw new HHApiError(message, {
          status: res.status,
          type: details.type ?? details.value,
          captchaUrl: details.captchaUrl,
          requestId: details.requestId,
        });
      }

      // Track retryable failures for diagnostics
      if (res.status === 403) {
        const bodyText = await res.text().catch(() => '');
        const details = parseHhError(bodyText);
        details.requestId = extractRequestId(res.headers, details.requestId);
        lastRequestId = details.requestId;
        if (details.type === 'captcha_required' || details.captchaUrl) {
          countCaptcha += 1;
          lastCaptchaUrl = details.captchaUrl;
        } else if (details.type === 'oauth') {
          countOauth403 += 1;
        } else if (details.type === 'forbidden' || !details.type) {
          countAntiBot403 += 1;
        }
        count403 += 1;
      } else if (res.status === 429) {
        count429 += 1;
      } else {
        count5xx += 1;
      }

      if (res.status === 429 || res.status === 403) {
        const backoff = retryAfterMs ?? Math.min(maxDelayMs, minDelayMs * 2 ** (attempt + 2));
        setGlobalBackoff(backoff);
      }

      lastProxyEntry = currentProxy;
      lastError = new HHApiError(
        `HH API HTTP ${res.status}`,
        {
          status: res.status,
          type: res.status === 403 ? 'forbidden' : 'retryable',
          requestId: lastRequestId,
          captchaUrl: lastCaptchaUrl,
        },
      );
      const base = retryAfterMs ?? Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
      continue;
    } catch (err) {
      const isProxyConnErr = currentProxy && isProxyConnectionError(err);
      if (isProxyConnErr && currentProxy) {
        countProxyFail += 1;
        markProxyFailed(currentProxy);
        lastProxyEntry = currentProxy;
        const reason = getFetchFailureReason(err);
        logError('hh.proxy_failed', err as Error, {
          url,
          proxy: currentProxy.url.replace(/:[^:@]+@/, ':***@'),
          reason,
          attempt: attempt + 1,
          maxRetries,
          consecutiveFailures: currentProxy.consecutiveFailures,
        });
        lastError = new Error(`Прокси недоступен: ${reason}`);
        if (attempt < maxRetries) {
          await sleep(Math.min(500, minDelayMs));
          continue;
        }
        break;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        countTimeout += 1;
        lastError = new Error('HH API: таймаут запроса');
      } else if (err instanceof HHApiError) {
        lastError = err;
        throw err;
      } else {
        const reason = getFetchFailureReason(err);
        const isGenericFetchFailed = err instanceof Error && err.message === 'fetch failed';
        if (isGenericFetchFailed && reason) {
          lastError = new Error(`Ошибка сети: ${reason}`);
          logError('hh.fetch_failed', err as Error, { url, reason, attempt: attempt + 1, maxRetries });
        } else {
          lastError = err;
        }
      }
      lastProxyEntry = currentProxy;
      if (attempt === maxRetries) break;
      const base = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (release) release();
    }
  }

  // Build a diagnostic error message so it's immediately clear what happened
  const totalAttempts = maxRetries + 1;
  const errMsg = buildRetryExhaustedMessage({
    totalAttempts,
    count403,
    count429,
    count5xx,
    countTimeout,
    countProxyFail,
    countCaptcha,
    countOauth403,
    countAntiBot403,
    lastStatus,
    lastCaptchaUrl,
    lastRequestId,
    proxyCount: PROXY_ENTRIES.length,
  });

  if (lastError instanceof HHApiError) {
    lastError.message = errMsg;
    throw lastError;
  }
  throw new HHApiError(errMsg, { status: lastStatus, type: 'retries_exhausted' });
}

function buildRetryExhaustedMessage(stats: {
  totalAttempts: number;
  count403: number;
  count429: number;
  count5xx: number;
  countTimeout: number;
  countProxyFail: number;
  countCaptcha: number;
  countOauth403: number;
  countAntiBot403: number;
  lastStatus: number;
  lastCaptchaUrl?: string;
  lastRequestId?: string;
  proxyCount: number;
}): string {
  const parts: string[] = [];

  if (stats.countCaptcha > 0) {
    parts.push(`HH API требует капчу (${stats.countCaptcha}×)${stats.lastCaptchaUrl ? ` — ${stats.lastCaptchaUrl}` : ''}`);
  } else if (stats.countOauth403 > 0 && stats.countOauth403 === stats.totalAttempts) {
    parts.push('HH API вернул OAuth-ошибку (403). Проверьте access_token/refresh_token и авторизацию приложения.');
  } else if (stats.countAntiBot403 > 0 && stats.countAntiBot403 === stats.totalAttempts) {
    parts.push(
      stats.proxyCount > 0
        ? `Все прокси заблокированы HH API (403 Forbidden × ${stats.count403}). Замените PROXY_URLS на новые IP.`
        : `HH API заблокировал IP сервера (403 Forbidden × ${stats.count403}). Настройте прокси в PROXY_URLS.`,
    );
  } else if (stats.count429 > 0 && stats.count429 === stats.totalAttempts) {
    parts.push(`HH API: превышен лимит запросов (429 × ${stats.count429}). Подождите и повторите.`);
  } else if (stats.countProxyFail > 0 && stats.countProxyFail === stats.totalAttempts) {
    parts.push(`Все прокси недоступны (${stats.countProxyFail} попыток). Проверьте PROXY_URLS — возможно, прокси истекли.`);
  } else if (stats.countTimeout > 0 && stats.countTimeout === stats.totalAttempts) {
    parts.push(`HH API не отвечает (таймаут × ${stats.countTimeout}).`);
  } else {
    // Mixed failures
    const details: string[] = [];
    if (stats.count403) details.push(`403 Forbidden × ${stats.count403}`);
    if (stats.count429) details.push(`429 Rate Limit × ${stats.count429}`);
    if (stats.count5xx) details.push(`5xx × ${stats.count5xx}`);
    if (stats.countTimeout) details.push(`таймаут × ${stats.countTimeout}`);
    if (stats.countProxyFail) details.push(`прокси недоступен × ${stats.countProxyFail}`);
    parts.push(`HH API: ${stats.totalAttempts} попыток неуспешны (${details.join(', ')})`);
  }

  if (stats.lastRequestId) {
    parts.push(`request_id: ${stats.lastRequestId}`);
  }

  return parts.join('. ');
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

  if (normalized.text?.includes('|')) {
    const terms = normalized.text.split('|').map((s) => s.trim()).filter(Boolean);
    if (terms.length > 1) {
      const subConfigs = terms.map((t) => ({ ...normalized, text: t }));
      const allParts: HHSearchConfig[] = [];
      await mapWithConcurrency(subConfigs, PARTITION_CONCURRENCY, async (sub) => {
        const parts = await partitionQuerySingle(sub, trace);
        allParts.push(...parts);
      });
      return allParts;
    }
  }

  return partitionQuerySingle(normalized, trace);
}

async function partitionQuerySingle(config: HHSearchConfig, trace?: Span | null): Promise<HHSearchConfig[]> {
  const found = await fetchFound(config, trace);
  if (found <= FOUND_LIMIT) return [config];

  const dateFrom = config.date_from ? parseISODate(config.date_from) : null;
  const dateTo = config.date_to ? parseISODate(config.date_to) : null;

  if (dateFrom && dateTo && dateFrom < dateTo) {
    return partitionByDate(config, dateFrom, dateTo, 0, trace);
  }

  const fallback = await partitionFallback(config);
  return fallback.length > 0 ? fallback : [config];
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

export type PartitionProgress = {
  total_subqueries: number;
  completed_subqueries: number;
  subquery_labels: string[];
  current_subquery: string | null;
};

type FetchVacanciesOptions = {
  jobId?: string;
  searchText?: string;
  shouldCancel?: () => Promise<boolean> | boolean;
  cancelCheckIntervalMs?: number;
  onProgress?: (progress: FetchVacanciesProgress) => void;
  progressIntervalMs?: number;
  onStage?: (stage: ParserProgressStage) => void;
  onPartitionProgress?: (info: PartitionProgress) => void;
  /** Called with a batch of new vacancies ready to be persisted. */
  onBatch?: (vacancies: HHVacancy[]) => Promise<void>;
  /** Minimum number of new vacancies to accumulate before calling onBatch. Default 1000. */
  batchFlushSize?: number;
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
  const pipeTerms = (normalized.text ?? '').split('|').filter((s) => s.trim()).length;
  const partitionTimeout = pipeTerms > 3
    ? PARTITION_TIMEOUT_MS + (pipeTerms - 3) * 30_000
    : PARTITION_TIMEOUT_MS;
  try {
    partitions = await withTimeout(
      partitionQuery(normalized, options?.trace),
      partitionTimeout,
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
  const partitionLabels = partitions.map((p) => {
    const parts: string[] = [];
    if (p.text) parts.push(p.text.length > 40 ? p.text.slice(0, 37) + '...' : p.text);
    if (p.date_from || p.date_to) parts.push(`${p.date_from ?? '...'} → ${p.date_to ?? '...'}`);
    return parts.join(' | ') || '—';
  });

  if (partitions.length > 1) {
    options?.onPartitionProgress?.({
      total_subqueries: partitions.length,
      completed_subqueries: 0,
      subquery_labels: partitionLabels,
      current_subquery: partitionLabels[0] ?? null,
    });
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
  let completedPartitions = 0;

  const batchFlushSize = options?.batchFlushSize ?? 1000;
  const flushedIds = new Set<string>();
  let pendingNewCount = 0;

  const flushBatch = async (force = false) => {
    if (!options?.onBatch) return;
    if (!force && pendingNewCount < batchFlushSize) return;
    const batch: HHVacancy[] = [];
    for (const [id, v] of uniqueVacancies) {
      if (!flushedIds.has(id)) {
        batch.push(v);
        flushedIds.add(id);
      }
    }
    pendingNewCount = 0;
    if (batch.length > 0) {
      await options.onBatch(batch);
    }
  };

  const registerItems = (items?: HHApiVacancyItem[]) => {
    if (!items || items.length === 0) return;
    for (const item of items) {
      fetchedCount += 1;
      const vacancy = mapVacancy(item);
      const existing = uniqueVacancies.get(vacancy.vacancy_id);
      if (!existing) {
        uniqueVacancies.set(vacancy.vacancy_id, vacancy);
        pendingNewCount += 1;
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
        await flushBatch();
        await partSpan?.end(
          { found: partFoundCapped, found_raw: partFound, fetched: partitionCollected, pages: totalPages },
          `Разбиение ${index + 1}: ${partitionCollected} вакансий`,
        );
        if (partitions.length > 1) {
          completedPartitions += 1;
          const nextIdx = Math.min(index + 1, partitions.length - 1);
          options?.onPartitionProgress?.({
            total_subqueries: partitions.length,
            completed_subqueries: completedPartitions,
            subquery_labels: partitionLabels,
            current_subquery: completedPartitions < partitions.length ? partitionLabels[nextIdx] : null,
          });
        }
      } catch (partErr) {
        await partSpan?.fail(partErr);
        // Re-throw cancellation
        if (partErr instanceof ParserJobCancelledError) throw partErr;

        partitionErrors += 1;
        if (partitions.length > 1) {
          completedPartitions += 1;
          options?.onPartitionProgress?.({
            total_subqueries: partitions.length,
            completed_subqueries: completedPartitions,
            subquery_labels: partitionLabels,
            current_subquery: completedPartitions < partitions.length ? partitionLabels[Math.min(index + 1, partitions.length - 1)] : null,
          });
        }
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

  await flushBatch(true);

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
    const failedEmployerIds: string[] = [];
    let processed = 0;
    await mapWithConcurrency(
      employerIds,
      EMPLOYER_CONCURRENCY,
      async (employerId) => {
        await checkCancelled();
        if (EMPLOYER_DELAY_MS > 0) await sleep(EMPLOYER_DELAY_MS);
        try {
          const info = await fetchEmployerDetails(employerId);
          employerCache.set(employerId, info);
        } catch {
          employerCache.set(employerId, {});
          failedEmployerIds.push(employerId);
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

    if (failedEmployerIds.length > 0) {
      // Retry failed employers with softer pace to recover from transient 429/5xx.
      let retried = 0;
      for (const employerId of failedEmployerIds) {
        await checkCancelled();
        try {
          const info = await fetchEmployerDetails(employerId);
          employerCache.set(employerId, info);
        } catch {
          // Keep empty cache entry from first pass.
        } finally {
          retried += 1;
          if (retried % 25 === 0 || retried === failedEmployerIds.length) {
            void logInfo(
              'parser.hh.employers.fetch.retry.progress',
              'HH employers retry progress',
              {
                jobId: options?.jobId,
                searchText: options?.searchText ?? normalized.text,
                retried,
                totalRetry: failedEmployerIds.length,
              },
              options?.logMeta,
            );
          }
          if (retried < failedEmployerIds.length) {
            await sleep(120);
          }
        }
      }
    }

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

