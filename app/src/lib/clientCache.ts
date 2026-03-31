/**
 * Simple in-memory TTL cache used EXCLUSIVELY by /api/client/* routes.
 * Internal portal routes (/api/instantly/*) are not affected.
 *
 * Implements stale-while-revalidate: once data has been fetched at least once,
 * stale entries are returned immediately while a background refresh runs.
 * Only the very first request (cold cache) blocks waiting for the API.
 */

interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number;
  fetchPromise?: Promise<T>;
}

const store = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// How long to keep serving stale data while refreshing in background.
// After this window the entry is considered fully expired and dropped.
const DEFAULT_STALE_MS = 30 * 60 * 1000; // 30 minutes

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
 * Get-or-fetch with stale-while-revalidate and in-flight deduplication.
 *
 * - Fresh hit  → return immediately.
 * - Stale hit  → return stale data immediately, kick off background refresh.
 * - In-flight  → join the existing promise (no duplicate API call).
 * - Cold cache → wait for the first fetch (unavoidable on server start).
 */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
  staleMs = DEFAULT_STALE_MS,
): Promise<T> {
  const existing = store.get(key);
  const now = Date.now();

  // Fresh — return immediately.
  if (existing && now <= existing.expiresAt) {
    return existing.data as T;
  }

  // Stale but still within the stale window — return old data, refresh in background.
  const hasStaleData = existing && existing.data !== null && existing.data !== undefined;
  const withinStaleWindow = existing && now <= existing.expiresAt + staleMs;
  if (hasStaleData && withinStaleWindow) {
    if (!existing.fetchPromise) {
      // Start background refresh without blocking the caller.
      const promise = fetcher()
        .then((data) => {
          store.set(key, { data, expiresAt: Date.now() + ttlMs });
          return data;
        })
        .catch(() => {
          // On error keep stale data and clear the promise so next request retries.
          const cur = store.get(key);
          if (cur?.fetchPromise === promise) {
            store.set(key, { ...cur, fetchPromise: undefined });
          }
          return existing.data as T;
        });
      store.set(key, { ...existing, fetchPromise: promise });
    }
    return existing.data as T;
  }

  // Already refreshing — join the in-flight promise.
  if (existing?.fetchPromise) {
    return existing.fetchPromise as Promise<T>;
  }

  // Cold cache — must wait for the first fetch.
  const promise = fetcher()
    .then((data) => {
      store.set(key, { data, expiresAt: Date.now() + ttlMs });
      return data;
    })
    .catch((err) => {
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
