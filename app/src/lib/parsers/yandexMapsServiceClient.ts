import { Agent as UndiciAgent } from 'undici';

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

export class YandexMapsBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YandexMapsBlockedError';
  }
}

/**
 * Пауза, которую обрывает отмена.
 *
 * Резолвится, а не бросает: решение, что делать с отменой, принимает
 * вызывающий код (та же форма, что sleepUnlessAborted в searchParserWorker.ts).
 */
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // AbortSignal не переигрывает уже случившуюся отмену для поздних
    // слушателей — поэтому проверка выше идёт до подписки.
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function getTimeoutMs() {
  // 990с: обязан быть БОЛЬШЕ серверных COLLECT_TIMEOUT_SEC / PARSE_TIMEOUT_SEC
  // (900с) — тогда сервис успевает сам завершиться и вернуть внятную ошибку.
  // Раньше было 600с < 900с: клиент обрывал стрим первым, на стороне сервиса
  // от этого утекал слот семафора (см. server.py) и сервис вставал намертво.
  const raw = Number(process.env.YANDEXMAPS_SERVICE_TIMEOUT_MS ?? '990000');
  return Number.isFinite(raw) && raw > 0 ? raw : 990000;
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

/**
 * Дефолтный undici-клиент в Node рвёт соединение через 300с тишины
 * (bodyTimeout: стрим без единого байта 5 минут) и через 300с ожидания
 * заголовков (headersTimeout: /parse-orgs думает до 900с прежде чем
 * ответить). Инцидент 15.07.2026 (#790ce9bf): все 9 запросов сбора ссылок
 * умерли с `TypeError: terminated` ровно через ~5 мин после последней
 * порции. Отключаем оба лимита — верхнюю границу держит AbortController
 * в fetchWithTimeout (990с).
 */
let longPollDispatcher: UndiciAgent | null = null;
function getLongPollDispatcher(): UndiciAgent {
  if (!longPollDispatcher) {
    longPollDispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });
  }
  return longPollDispatcher;
}

/**
 * Внешняя отмена (`signal`) складывается с собственным таймаутом запроса.
 *
 * Зачем внешняя: один вызов сервиса законно длится до 990 с, и тело задачи,
 * у которого отобрали аренду или которому пришёл SIGTERM, все эти минуты
 * продолжало бы гонять чужой браузер и чужие прокси. Обрыв соединения —
 * единственный способ остановить его за секунды.
 *
 * Цена обрыва: на стороне сервиса запрос отменяется вместе с клиентом.
 * Для /collect-links/stream это безопасно by design — освобождение семафора и
 * закрытие браузера там вынесены в отдельную task (инцидент 14.07.2026,
 * см. services/yandexmaps/server.py). Для /parse-orgs отмена может оставить
 * chromium недозакрытым: `finally: await parser.close()` в отменённом scope
 * не гарантирован. Это ровно тот же обрыв, что уже случается по 990-секундному
 * таймауту, и происходит он только на остановке воркера или потере аренды,
 * когда контейнер сервиса обычно пересоздаётся рядом.
 */
async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    // `dispatcher` — undici-расширение RequestInit, в типах lib.dom его нет.
    const initWithDispatcher = { ...init, dispatcher: getLongPollDispatcher(), signal: controller.signal } as RequestInit;
    return await fetch(input, initWithDispatcher);
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const url = `${getServiceUrl()}${path}`;
  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Отмена ретраи прекращает: повторять запрос за чужой счёт бессмысленно.
    if (signal?.aborted) throw new Error('yandexmaps request aborted');
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
        signal,
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 429) {
          throw new YandexMapsBlockedError(
            text ? `yandex_blocked: ${text.slice(0, 300)}` : 'yandex_blocked',
          );
        }
        throw new YandexMapsServiceHttpError(
          `yandexmaps service error ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof YandexMapsServiceHttpError) throw err;
      if (err instanceof YandexMapsBlockedError) throw err;
      lastErr = err;
      if (attempt >= maxRetries) break;
      await sleep(250 * Math.pow(2, attempt), signal);
    }
  }

  const summary = summarizeError(lastErr);
  const details = JSON.stringify(errorDetails(lastErr));
  throw new Error(`yandexmaps fetch failed (${summary}): ${url} ${details}`, { cause: lastErr });
}

export async function yandexMapsHealth(signal?: AbortSignal): Promise<boolean> {
  const url = `${getServiceUrl()}/health`;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, Math.min(getTimeoutMs(), 15000), signal);
    return res.ok;
  } catch {
    return false;
  }
}

export type ProxyCheckResult = { ok: boolean; speed_bps: number; seconds?: number; bytes?: number; error?: string };

/**
 * Замер скорости прокси через сервис (без браузера). Возвращает null, если
 * сам чек недоступен (старый образ сервиса без /proxy-check, сетевая ошибка) —
 * вызывающий код трактует это как «фильтровать нечем, используем весь пул».
 */
export async function yandexMapsProxyCheck(proxy: YandexMapsProxy, timeoutSec = 15): Promise<ProxyCheckResult | null> {
  const url = `${getServiceUrl()}/proxy-check`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxy, timeout_sec: timeoutSec }),
      },
      (timeoutSec + 10) * 1000,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as ProxyCheckResult;
    return typeof data?.ok === 'boolean' ? data : null;
  } catch {
    return null;
  }
}

export async function yandexMapsCollectLinks(req: CollectLinksRequest, signal?: AbortSignal): Promise<CollectLinksResponse> {
  return await postJson<CollectLinksResponse>('/collect-links', req, signal);
}

export type CollectLinksChunk = {
  links: string[];
  total: number;
  done?: boolean;
  error?: string;
  blocked?: boolean;
  /** Пульс сервиса: «жив, но новых ссылок нет» — просто держит стрим тёплым. */
  heartbeat?: boolean;
  /** Яндекс перенаправил ru->com (зарубежный прокси): выдача урезана до первого экрана. */
  intl_redirect?: boolean;
};

/**
 * Streaming version: calls /collect-links/stream and invokes onChunk for every
 * NDJSON line so the caller can persist links to DB incrementally.
 */
export async function yandexMapsCollectLinksStream(
  req: CollectLinksRequest,
  onChunk: (chunk: CollectLinksChunk) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<{ links: string[]; total: number; intlRedirect: boolean }> {
  const url = `${getServiceUrl()}/collect-links/stream`;
  const timeoutMs = getTimeoutMs();
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    },
    timeoutMs,
    signal,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new YandexMapsServiceHttpError(
      `yandexmaps stream error ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
  }

  if (!res.body) throw new Error('No response body from streaming endpoint');

  const allLinks: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let intlRedirect = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: CollectLinksChunk;
      try {
        parsed = JSON.parse(trimmed) as CollectLinksChunk;
      } catch {
        continue;
      }

      if (parsed.error) {
        if (parsed.blocked || /yandex_blocked/i.test(parsed.error)) {
          throw new YandexMapsBlockedError(`yandexmaps stream: ${parsed.error}`);
        }
        throw new Error(`yandexmaps stream: ${parsed.error}`);
      }

      if (parsed.links) {
        for (const link of parsed.links) {
          if (!seen.has(link)) {
            seen.add(link);
            allLinks.push(link);
          }
        }
      }
      total = parsed.total ?? total;
      if (parsed.intl_redirect) intlRedirect = true;

      await onChunk({ links: parsed.links ?? [], total, done: parsed.done, heartbeat: parsed.heartbeat });
    }

    if (done) break;
  }

  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim()) as CollectLinksChunk;
      if (parsed.links) {
        for (const link of parsed.links) {
          if (!seen.has(link)) {
            seen.add(link);
            allLinks.push(link);
          }
        }
      }
      total = parsed.total ?? total;
      if (parsed.intl_redirect) intlRedirect = true;
      await onChunk({ links: parsed.links ?? [], total, done: parsed.done, heartbeat: parsed.heartbeat });
    } catch { /* ignore trailing partial */ }
  }

  return { links: allLinks, total, intlRedirect };
}

export async function yandexMapsParseOrgs(req: ParseOrgsRequest, signal?: AbortSignal): Promise<ParseOrgsResponse> {
  return await postJson<ParseOrgsResponse>('/parse-orgs', req, signal);
}

