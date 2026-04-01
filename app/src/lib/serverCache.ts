import 'server-only';

/**
 * In-memory TTL cache for server-side API routes.
 *
 * Each Node cluster worker maintains its own cache instance.
 * For global (non-user-specific) data this still dramatically reduces
 * redundant DB/API calls under concurrent traffic.
 */

interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number;
  fetchPromise?: Promise<T>;
}

const store = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 60 * 1000; // 1 minute

/**
 * Get-or-fetch with stale-while-revalidate and in-flight deduplication.
 *
 * - Fresh hit  -> return immediately.
 * - In-flight  -> join the existing promise (no duplicate call).
 * - Expired    -> fetch fresh data (first caller blocks, rest join).
 */
export async function serverCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const existing = store.get(key);
  const now = Date.now();

  if (existing && now <= existing.expiresAt) {
    return existing.data as T;
  }

  if (existing?.fetchPromise) {
    return existing.fetchPromise as Promise<T>;
  }

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

export function invalidateServer(keyPrefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(keyPrefix)) store.delete(key);
  }
}
