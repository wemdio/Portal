'use client';

import { authFetchJson } from '@/lib/authFetch';

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

  return `${method} /api/client${path}`;
}

export async function clientApiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `/api/client${path}`;
  const key = dedupKey(path, init);
  if (!key) return authFetchJson<T>(url, init);

  const existing = inFlightClientReads.get(key);
  if (existing) return existing as Promise<T>;

  const request = authFetchJson<T>(url, init).finally(() => {
    if (inFlightClientReads.get(key) === request) {
      inFlightClientReads.delete(key);
    }
  });
  inFlightClientReads.set(key, request);
  return request;
}
