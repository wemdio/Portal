export type YandexMapsProxy = {
  enabled?: boolean;
  protocol?: 'http' | 'https' | 'socks5';
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
};

export type YandexMapsOrganization = {
  name: string;
  country: string;
  city: string;
  address: string;
  rating: string;
  reviews_count: string;
  website: string;
  email: string;
  phone: string;
  telegram: string;
  vk: string;
  instagram: string;
  whatsapp: string;
  card_url: string;
  working_hours: string;
  categories: string;
};

export type CollectLinksRequest = {
  search_url: string;
  max_results?: number;
  headless?: boolean;
  proxy?: YandexMapsProxy;
};

export type CollectLinksResponse = { links: string[] };

export type ParseOrgsRequest = {
  links: string[];
  headless?: boolean;
  proxy?: YandexMapsProxy;
};

export type ParseOrgsResponse = { organizations: YandexMapsOrganization[] };

function getServiceUrl() {
  const fromEnv = process.env.YANDEXMAPS_SERVICE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const fallback = process.env.NODE_ENV === 'production' ? 'http://yandexmaps:8000' : 'http://127.0.0.1:8010';
  return fallback;
}

class YandexMapsServiceHttpError extends Error {}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function getTimeoutMs() {
  const raw = Number(process.env.YANDEXMAPS_SERVICE_TIMEOUT_MS ?? '600000');
  return Number.isFinite(raw) && raw > 0 ? raw : 600000;
}

function getMaxRetries() {
  const raw = Number(process.env.YANDEXMAPS_SERVICE_MAX_RETRIES ?? '2');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

function errorDetails(err: unknown): Record<string, unknown> {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown; code?: unknown; errno?: unknown };
  const cause = e?.cause as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown } | undefined;
  const nestedCause = cause?.cause as { code?: unknown; errno?: unknown; message?: unknown } | undefined;
  return {
    name: typeof e?.name === 'string' ? e.name : undefined,
    message: typeof e?.message === 'string' ? e.message : undefined,
    code: typeof e?.code === 'string' ? e.code : undefined,
    errno: typeof e?.errno === 'string' ? e.errno : undefined,
    cause_code: typeof cause?.code === 'string' ? cause.code : undefined,
    cause_errno: typeof cause?.errno === 'string' ? cause.errno : undefined,
    cause_message: typeof cause?.message === 'string' ? cause.message : undefined,
    nested_cause_code: typeof nestedCause?.code === 'string' ? nestedCause.code : undefined,
    nested_cause_message: typeof nestedCause?.message === 'string' ? nestedCause.message : undefined,
    stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 5).join('\n') : undefined,
  };
}

function summarizeError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string; cause?: { code?: string; message?: string } } };
  const parts: string[] = [];
  if (e?.message) parts.push(e.message);
  if (e?.cause?.code) parts.push(`cause: ${e.cause.code}`);
  else if (e?.cause?.message) parts.push(`cause: ${e.cause.message}`);
  if (e?.cause?.cause?.code) parts.push(`root: ${e.cause.cause.code}`);
  else if (e?.cause?.cause?.message) parts.push(`root: ${e.cause.cause.message}`);
  return parts.join(' | ') || 'unknown error';
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${getServiceUrl()}${path}`;
  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new YandexMapsServiceHttpError(
          `yandexmaps service error ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof YandexMapsServiceHttpError) throw err;
      lastErr = err;
      if (attempt >= maxRetries) break;
      await sleep(250 * Math.pow(2, attempt));
    }
  }

  const summary = summarizeError(lastErr);
  const details = JSON.stringify(errorDetails(lastErr));
  throw new Error(`yandexmaps fetch failed (${summary}): ${url} ${details}`, { cause: lastErr });
}

export async function yandexMapsHealth(): Promise<boolean> {
  const url = `${getServiceUrl()}/health`;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, Math.min(getTimeoutMs(), 15000));
    return res.ok;
  } catch {
    return false;
  }
}

export async function yandexMapsCollectLinks(req: CollectLinksRequest): Promise<CollectLinksResponse> {
  return await postJson<CollectLinksResponse>('/collect-links', req);
}

export async function yandexMapsParseOrgs(req: ParseOrgsRequest): Promise<ParseOrgsResponse> {
  return await postJson<ParseOrgsResponse>('/parse-orgs', req);
}

