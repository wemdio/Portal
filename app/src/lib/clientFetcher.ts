'use client';

import { authFetchJson, isAuthExpiredError } from '@/lib/authFetch';
import { scrubBrand } from '@/lib/scrubBrand';
import { isTabDemoMode } from '@/lib/clientDemo/tabDemoMode';
import { TAB_DEMO_HEADER } from '@/lib/clientDemo/demoHeader';

const inFlightClientReads = new Map<string, Promise<unknown>>();

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function dedupKey(path: string, init?: RequestInit): string | null {
  const method = requestMethod(init);
  if (method !== 'GET' && method !== 'HEAD') return null;

  // Keep this deliberately narrow: only plain read calls without headers,
  // abort signals, cache flags, or bodies are shared.
  const initKeys = Object.keys(init ?? {}).filter((key) => key !== 'method');
  if (initKeys.length > 0) return null;

  // Флаг демо-вкладки — часть ключа: до захвата ?demo=1 и после него в одной
  // вкладке могут жить оба набора данных (реальный + фикстуры), их нельзя
  // склеивать в один in-flight.
  return `${method} /api/client${path} demo:${isTabDemoMode() ? '1' : '0'}`;
}

/**
 * Демо-вкладка (?demo=1, sessionStorage) помечает свои запросы заголовком —
 * сервер по нему отдаёт фикстуры (см. requireClientAuth). Обычные вкладки
 * заголовок не шлют, поведение не меняется.
 */
function withDemoHeader(init?: RequestInit): RequestInit | undefined {
  if (!isTabDemoMode()) return init;
  const headers = new Headers(init?.headers);
  headers.set(TAB_DEMO_HEADER, '1');
  return { ...init, headers };
}

/**
 * Client-side white-label scrub: strip the email-engine brand from any error
 * surfaced to the client. PRESERVES the AuthExpiredError instance so callers'
 * isAuthExpiredError(err) recovery checks keep working. Catch-all for the few
 * client routes that return errors raw (bypassing the server-side jsonError scrub).
 */
function scrubClientError(e: unknown): unknown {
  if (isAuthExpiredError(e)) return e;
  if (e instanceof Error) e.message = scrubBrand(e.message);
  return e;
}

export async function clientApiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `/api/client${path}`;
  const key = dedupKey(path, init);
  if (!key) return authFetchJson<T>(url, withDemoHeader(init)).catch((e) => { throw scrubClientError(e); });

  const existing = inFlightClientReads.get(key);
  if (existing) return existing as Promise<T>;

  const request = authFetchJson<T>(url, withDemoHeader(init)).catch((e) => { throw scrubClientError(e); }).finally(() => {
    if (inFlightClientReads.get(key) === request) {
      inFlightClientReads.delete(key);
    }
  });
  inFlightClientReads.set(key, request);
  return request;
}
