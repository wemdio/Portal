import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export type CurlRequestInit = {
  method?: string;
  body?: string;
};

export type CurlLike = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  init?: CurlRequestInit,
) => Promise<string>;

type FetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  body?: string;
  fetchImpl?: FetchLike;
  curlImpl?: CurlLike;
  /**
   * Остановка воркера (единый жизненный цикл задач). Складывается с
   * собственным таймаутом запроса; когда он взведён, curl-фолбэк НЕ
   * запускается — иначе прерванный fetch тут же уходил бы тем же запросом в
   * дочерний процесс, и остановка не наблюдалась бы вовсе.
   */
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_UA = 'PortalAtsParser/1.0 (+https://wemd.io)';

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent': DEFAULT_UA,
    ...(headers ?? {}),
  };
}

async function defaultCurl(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  init?: CurlRequestInit,
): Promise<string> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = [
    '-sS',
    '-L',
    '--http1.1',
    '--compressed',
    '--connect-timeout',
    '10',
    '--max-time',
    String(seconds),
  ];

  if (init?.method && init.method.toUpperCase() !== 'GET') {
    args.push('-X', init.method.toUpperCase());
  }

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }

  // execFile passes args verbatim (no shell), so a JSON body is safe as one argv.
  if (init?.body != null) {
    args.push('--data-raw', init.body);
  }

  args.push(url);

  // The WAF in front of Workday CXS blocks by TLS fingerprint, and whether a
  // given curl build passes depends on the binary — so prod can point this at a
  // curl-impersonate binary via ATS_CURL_BIN without a code redeploy.
  const curlBin = process.env.ATS_CURL_BIN?.trim() || 'curl';
  const { stdout } = await execFileP(curlBin, args, {
    timeout: timeoutMs + 5_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export async function fetchTextWithFallback(url: string, options: FetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = normalizeHeaders(options.headers);
  const fetchImpl = options.fetchImpl ?? fetch;
  const curlImpl = options.curlImpl ?? defaultCurl;
  const method = options.method ?? 'GET';
  const isWrite = method !== 'GET';

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(isWrite ? { body: options.body } : {}),
      signal: options.signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    if (options.signal?.aborted) throw err;
    // Keep GET callers (and their tests) on the original 3-arg curl contract;
    // only writes need the method/body init (e.g. Workday CXS POST behind a WAF).
    return isWrite
      ? curlImpl(url, headers, timeoutMs, { method, body: options.body })
      : curlImpl(url, headers, timeoutMs);
  }
}

export async function fetchJsonWithFallback(url: string, options: FetchOptions = {}): Promise<unknown> {
  const text = await fetchTextWithFallback(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });
  try {
    return JSON.parse(text);
  } catch (err) {
    const preview = text.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : 'parse failed'} (${preview})`);
  }
}
