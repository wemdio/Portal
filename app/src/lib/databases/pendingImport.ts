'use client';

export type PendingDbImportV1 = {
  version: 1;
  title: string;
  rows: string[][];
  created_at: string;
};

const STORAGE_PREFIX = 'portal:db-import:v1:';

const IDB_DB_NAME = 'portal-db-imports';
const IDB_STORE_NAME = 'imports';

let idbConnectionPromise: Promise<IDBDatabase> | null = null;

function openImportsDb(): Promise<IDBDatabase> {
  if (!idbConnectionPromise) {
    idbConnectionPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(IDB_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    // A failed open must not be cached forever — allow a retry on the next call.
    idbConnectionPromise.catch(() => {
      idbConnectionPromise = null;
    });
  }
  return idbConnectionPromise;
}

function idbGet(id: string): Promise<unknown> {
  return openImportsDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STORE_NAME, 'readonly').objectStore(IDB_STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
      }),
  );
}

function idbRunReadWrite(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void> {
  return openImportsDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE_NAME, mode);
        run(tx.objectStore(IDB_STORE_NAME));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

function createId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function validatePayload(parsed: PendingDbImportV1 | null): PendingDbImportV1 | null {
  if (!parsed) return null;
  if (parsed.version !== 1) return null;
  if (typeof parsed.title !== 'string') return null;
  if (!Array.isArray(parsed.rows)) return null;
  return parsed;
}

function readLegacy(id: string): PendingDbImportV1 | null {
  try {
    return validatePayload(safeJsonParse<PendingDbImportV1>(window.localStorage.getItem(`${STORAGE_PREFIX}${id}`)));
  } catch {
    return null;
  }
}

export async function writePendingDbImport(input: { title: string; rows: string[][] }): Promise<{ id: string }> {
  const id = createId();
  const payload: PendingDbImportV1 = {
    version: 1,
    title: input.title,
    rows: input.rows,
    created_at: new Date().toISOString(),
  };
  try {
    await idbRunReadWrite('readwrite', (store) => {
      store.put(payload, id);
    });
    return { id };
  } catch {
    // IndexedDB unavailable (private mode, disabled) — fall back to localStorage.
  }
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(payload));
    return { id };
  } catch {
    throw new Error('Не удалось сохранить данные импорта (хранилище браузера переполнено)');
  }
}

export async function readPendingDbImport(id: string): Promise<PendingDbImportV1 | null> {
  try {
    const payload = validatePayload(((await idbGet(id)) as PendingDbImportV1 | undefined) ?? null);
    if (payload) return payload;
  } catch {
    // IndexedDB unavailable — fall back to localStorage below.
  }
  return readLegacy(id);
}

export async function deletePendingDbImport(id: string): Promise<void> {
  try {
    await idbRunReadWrite('readwrite', (store) => {
      store.delete(id);
    });
  } catch {
    // Best-effort cleanup; still try the legacy key below.
  }
  try {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
  } catch {
    // ignore
  }
}

export function buildDatabasesImportUrl(id: string) {
  return `/tools/databases?import=${encodeURIComponent(id)}`;
}
