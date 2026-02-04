export type HHSearchConfig = {
  text: string;
  area?: string | string[];
  salary_from?: number;
  currency?: string;
  date_from?: string;
  date_to?: string;
  per_page?: number;
  params?: Record<string, string | string[]>;
};

export type HHVacancy = {
  vacancy_id: string;
  name: string;
  url: string;
  salary_from?: number;
  salary_to?: number;
  salary_currency?: string;
  company_name: string;
  company_url?: string;
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
  employer: { name: string; alternate_url: string | null };
  area: { name: string };
  published_at?: string;
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

const HH_API_BASE = 'https://api.hh.ru';
const FOUND_LIMIT = 2000;
const MIN_REQUEST_INTERVAL_MS = 250;

let throttleChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

type HHSearchParams = Record<string, string | string[]>;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

function buildHhErrorMessage(status: number, details: { type?: string; captchaUrl?: string }, bodyText: string) {
  if (details.type === 'captcha_required' || details.captchaUrl) {
    return 'HH API требует капчу. Откройте ссылку ниже, решите капчу и повторите запрос.';
  }
  if (details.type) return `HH API error ${status}: ${details.type}`;
  if (bodyText) return `HH API error ${status}: ${bodyText}`;
  return `HH API error ${status}`;
}

async function throttleHhRequest() {
  throttleChain = throttleChain.then(async () => {
    const now = Date.now();
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - now;
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  await throttleChain;
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
  opts?: { maxRetries?: number; minDelayMs?: number; maxDelayMs?: number }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 5;
  const minDelayMs = opts?.minDelayMs ?? 500;
  const maxDelayMs = opts?.maxDelayMs ?? 20_000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await throttleHhRequest();
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Portal/1.0 (HH parser)',
          Accept: 'application/json',
        },
        cache: 'no-store',
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;

      const shouldRetry = res.status === 429 || (res.status >= 500 && res.status <= 599);
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

      const base = retryAfterMs ?? Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
      continue;
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      const base = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('HH API request failed');
}

async function fetchFound(config: HHSearchConfig): Promise<number> {
  const url = buildVacanciesUrl({ ...config, per_page: 1 }, 0);
  const data = await fetchWithRetry<HHApiVacanciesResponse>(url);
  return data.found ?? 0;
}

export async function partitionQuery(config: HHSearchConfig): Promise<HHSearchConfig[]> {
  const normalized = normalizeSearchParams(config);
  const found = await fetchFound(normalized);
  if (found <= FOUND_LIMIT) return [normalized];

  const dateFrom = normalized.date_from ? parseISODate(normalized.date_from) : null;
  const dateTo = normalized.date_to ? parseISODate(normalized.date_to) : null;

  if (dateFrom && dateTo && dateFrom < dateTo) {
    return partitionByDate(normalized, dateFrom, dateTo, 0);
  }

  const fallback = await partitionFallback(normalized);
  return fallback.length > 0 ? fallback : [normalized];
}

async function partitionByDate(config: HHSearchConfig, from: Date, to: Date, depth: number): Promise<HHSearchConfig[]> {
  if (depth >= 14) return [config];

  const fromISO = toISODate(from);
  const toISO = toISODate(to);
  const current = { ...config, date_from: fromISO, date_to: toISO };
  const found = await fetchFound(current);
  if (found <= FOUND_LIMIT) return [current];

  const mid = midDate(from, to);
  if (mid <= from || mid >= to) {
    const fallback = await partitionFallback(current);
    return fallback.length > 0 ? fallback : [current];
  }

  const left: HHSearchConfig = { ...config, date_from: fromISO, date_to: toISODate(mid) };
  const right: HHSearchConfig = { ...config, date_from: toISODate(mid), date_to: toISO };

  const [leftFound, rightFound] = await Promise.all([fetchFound(left), fetchFound(right)]);
  if (leftFound === found && rightFound === found) {
    const fallback = await partitionFallback(current);
    return fallback.length > 0 ? fallback : [current];
  }

  const [leftParts, rightParts] = await Promise.all([
    leftFound > FOUND_LIMIT ? partitionByDate(left, from, mid, depth + 1) : [{ ...left }],
    rightFound > FOUND_LIMIT ? partitionByDate(right, mid, to, depth + 1) : [{ ...right }],
  ]);

  return [...leftParts, ...rightParts];
}

async function partitionFallback(config: HHSearchConfig): Promise<HHSearchConfig[]> {
  if (Array.isArray(config.area) && config.area.length > 1) {
    const mid = Math.ceil(config.area.length / 2);
    const left = config.area.slice(0, mid);
    const right = config.area.slice(mid);
    const parts: HHSearchConfig[] = [];
    if (left.length) parts.push({ ...config, area: left });
    if (right.length) parts.push({ ...config, area: right });
    return parts;
  }

  if (config.text.includes('|')) {
    const parts = config.text
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts.map((t) => ({ ...config, text: t }));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setDate(from.getDate() - 30);

  const withDates: HHSearchConfig = {
    ...config,
    date_from: config.date_from ?? toISODate(from),
    date_to: config.date_to ?? toISODate(today),
  };

  const dateFrom = withDates.date_from ? parseISODate(withDates.date_from) : null;
  const dateTo = withDates.date_to ? parseISODate(withDates.date_to) : null;
  if (dateFrom && dateTo && dateFrom < dateTo) {
    return partitionByDate(withDates, dateFrom, dateTo, 0);
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
    company_name: item.employer?.name ?? '',
    company_url: item.employer?.alternate_url ?? undefined,
    area: item.area?.name ?? '',
    industries: [],
    published_at: item.published_at,
  };
}

export async function fetchVacancies(config: HHSearchConfig): Promise<{ found: number; vacancies: HHVacancy[] }> {
  const normalized = normalizeSearchParams(config);
  const partitions = await partitionQuery(normalized);

  let totalFound = 0;
  const all: HHVacancy[] = [];

  for (const part of partitions) {
    const firstUrl = buildVacanciesUrl(part, 0);
    const first = await fetchWithRetry<HHApiVacanciesResponse>(firstUrl);
    totalFound += first.found ?? 0;

    for (const item of first.items ?? []) all.push(mapVacancy(item));

    const totalPages = Math.min(first.pages ?? 0, Math.ceil(FOUND_LIMIT / (part.per_page ?? 50)));
    for (let page = 1; page < totalPages; page++) {
      await sleep(200);
      const url = buildVacanciesUrl(part, page);
      const data = await fetchWithRetry<HHApiVacanciesResponse>(url);
      for (const item of data.items ?? []) all.push(mapVacancy(item));
    }
  }

  return { found: totalFound, vacancies: all };
}

