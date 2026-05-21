/**
 * Параллельная загрузка подстраниц с graceful degradation.
 *
 * Используется enricher'ами после discoverSubpages(). Если одна подстраница
 * не отвечает или возвращает 404 — это **не должно валить весь enrichment**;
 * другие страницы могут дать нужный контент.
 *
 * - Один общий тайм-аут на все запросы (по умолчанию 12s) + per-page тайм-аут
 *   (8s) — потому что fetchWebsiteHtml без общего бюджета может потратить
 *   N*15s, если все страницы тормозят.
 * - Возвращает массив с тем же порядком, что и на входе; ошибки представлены
 *   объектом { error }, не выбрасываются.
 * - Жёсткий cap на per-page bytes (~300 KB) — мы потом всё равно режем текст
 *   до ~15K символов, нет смысла качать мегабайты.
 */

import { fetchWebsiteHtml, WebsiteFetchError } from './fetchWebsiteHtml';

const DEFAULT_PER_PAGE_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12_000;
const DEFAULT_PER_PAGE_MAX_BYTES = 300_000;

export interface FetchSubpagesInput {
  urls: readonly string[];
  perPageTimeoutMs?: number;
  totalTimeoutMs?: number;
  perPageMaxBytes?: number;
  /** Optional injected fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface FetchedSubpage {
  /** Запрошенный URL (как пришёл на вход). */
  url: string;
  /** Финальный URL после редиректов; undefined если запрос упал до получения ответа. */
  resolvedUrl?: string;
  /** HTML, если успех. */
  html?: string;
  /** Сообщение об ошибке, если фейл. */
  error?: string;
}

/**
 * Загружает все URL параллельно с общим тайм-аутом.
 *
 * Тонкость: даже если общий тайм-аут истёк, мы возвращаем результаты тех
 * запросов, что успели вернуться. Это даёт лучший UX чем «всё или ничего».
 */
export async function fetchSubpages(input: FetchSubpagesInput): Promise<FetchedSubpage[]> {
  const {
    urls,
    perPageTimeoutMs = DEFAULT_PER_PAGE_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    perPageMaxBytes = DEFAULT_PER_PAGE_MAX_BYTES,
    fetchImpl,
  } = input;

  if (!urls || urls.length === 0) return [];

  // Глобальный сигнал отмены — когда сработает, все live-запросы получат AbortSignal.
  const globalController = new AbortController();
  const globalTimeoutId = setTimeout(() => globalController.abort(), totalTimeoutMs);

  const wrappedFetch: typeof fetch = fetchImpl
    ? // Прокинуть глобальный сигнал в инжектированный fetch, объединяя с per-page signal.
      ((url, init) => {
        const merged = mergeSignals(init?.signal ?? null, globalController.signal);
        return fetchImpl(url, { ...init, signal: merged });
      }) as typeof fetch
    : ((url, init) => {
        const merged = mergeSignals(init?.signal ?? null, globalController.signal);
        return fetch(url, { ...init, signal: merged });
      }) as typeof fetch;

  const tasks = urls.map<Promise<FetchedSubpage>>(async (url) => {
    try {
      const { url: resolvedUrl, html } = await fetchWebsiteHtml(url, {
        fetchImpl: wrappedFetch,
        timeoutMs: perPageTimeoutMs,
        maxBytes: perPageMaxBytes,
      });
      return { url, resolvedUrl, html };
    } catch (err) {
      // Если глобальный тайм-аут сработал — у нас будет AbortError.
      if (globalController.signal.aborted) {
        return { url, error: 'Общий тайм-аут истёк до получения ответа' };
      }
      if (err instanceof WebsiteFetchError) {
        return { url, error: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown fetch error';
      return { url, error: message };
    }
  });

  try {
    return await Promise.all(tasks);
  } finally {
    clearTimeout(globalTimeoutId);
  }
}

/**
 * Возвращает AbortSignal, который abort'нется когда любой из входных сигналов
 * abort'нется. Используется чтобы скомбинировать per-page и global тайм-ауты.
 */
function mergeSignals(a: AbortSignal | null, b: AbortSignal): AbortSignal {
  if (!a) return b;
  // AbortSignal.any доступен в Node 20+. Подстраховка на случай старых раннеров.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return anyFn([a, b]);
  }
  const controller = new AbortController();
  const onAbortA = () => controller.abort(a.reason);
  const onAbortB = () => controller.abort(b.reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener('abort', onAbortA, { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener('abort', onAbortB, { once: true });
  return controller.signal;
}
