/**
 * Simple in-memory TTL cache used EXCLUSIVELY by /api/client/* routes.
 * Internal portal routes (/api/instantly/*) are not affected.
 */

interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number;
  fetchPromise?: Promise<T>;
}

const store = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttlMs = DEFAULT_TTL_MS): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * Get-or-fetch with deduplication: concurrent requests for the same key
 * share a single in-flight fetch instead of hitting the API N times.
 */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const existing = store.get(key);
  if (existing && Date.now() <= existing.expiresAt) {
    return existing.data as T;
  }

  if (existing?.fetchPromise) {
    return existing.fetchPromise as Promise<T>;
  }

  const promise = fetcher().then((data) => {
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  }).catch((err) => {
    if (store.get(key)?.fetchPromise === promise) store.delete(key);
    throw err;
  });

  store.set(key, { data: null as T, expiresAt: 0, fetchPromise: promise });
  return promise;
}

export function invalidate(keyPrefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(keyPrefix)) store.delete(key);
  }
}
