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

/**
 * Очередь непотреблённых импортов.
 *
 * Раньше единственным способом довезти данные парсера до «Работы с базами»
 * была ссылка «Перейти» в тосте — а тост гаснет через 3.5 сек. Не успел
 * кликнуть — данные лежали в IndexedDB мёртвым грузом: страница «Базы»
 * знала об импорте только из ?import=<id> в URL. Отсюда жалоба «нажал
 * “в базу”, зашёл в базы — там пусто».
 *
 * Теперь каждый импорт дополнительно регистрируется в лёгком индексе
 * (только метаданные, сами строки остаются в IndexedDB), и страница «Базы»
 * при открытии подбирает всё непотреблённое сама, без ссылки в тосте.
 */
const QUEUE_KEY = 'portal:db-import:queue:v1';
const QUEUE_VERSION = 1;
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_MAX_ENTRIES = 50;

export type PendingDbImportEntry = {
  id: string;
  title: string;
  rows: number;
  created_at: string;
};

type PendingDbImportQueue = {
  version: number;
  entries: PendingDbImportEntry[];
};

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

function readQueue(): PendingDbImportQueue {
  const empty: PendingDbImportQueue = { version: QUEUE_VERSION, entries: [] };
  try {
    const parsed = safeJsonParse<PendingDbImportQueue>(window.localStorage.getItem(QUEUE_KEY));
    if (!parsed || parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.entries)) return empty;
    const entries = parsed.entries.filter(
      (entry): entry is PendingDbImportEntry =>
        Boolean(entry) && typeof entry.id === 'string' && entry.id.length > 0,
    );
    return { version: QUEUE_VERSION, entries };
  } catch {
    return empty;
  }
}

function writeQueue(queue: PendingDbImportQueue) {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Индекс крошечный; если и он не влез — очередь просто не работает,
    // импорт остаётся доступен по ссылке «Перейти».
  }
}

function isFresh(entry: PendingDbImportEntry): boolean {
  const createdAt = Date.parse(entry.created_at);
  if (!Number.isFinite(createdAt)) return false;
  return Date.now() - createdAt < QUEUE_TTL_MS;
}

/**
 * Непотреблённые импорты, старые первыми. Протухшие записи вычищаются
 * (вместе с их payload'ами в IndexedDB) — иначе полугодовой парсинг
 * всплыл бы новой вкладкой при следующем заходе в «Базы».
 */
export function listPendingDbImports(): PendingDbImportEntry[] {
  const queue = readQueue();
  const fresh = queue.entries.filter(isFresh);
  if (fresh.length !== queue.entries.length) {
    for (const entry of queue.entries) {
      if (!isFresh(entry)) void deletePendingDbImport(entry.id);
    }
    writeQueue({ version: QUEUE_VERSION, entries: fresh });
  }
  return fresh;
}

function enqueue(entry: PendingDbImportEntry) {
  const queue = readQueue();
  const entries = [...queue.entries.filter((item) => item.id !== entry.id), entry];
  writeQueue({ version: QUEUE_VERSION, entries: entries.slice(-QUEUE_MAX_ENTRIES) });
}

function dequeue(id: string) {
  const queue = readQueue();
  const entries = queue.entries.filter((entry) => entry.id !== id);
  if (entries.length !== queue.entries.length) {
    writeQueue({ version: QUEUE_VERSION, entries });
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
  const register = () => {
    enqueue({
      id,
      title: payload.title,
      rows: payload.rows.length,
      created_at: payload.created_at,
    });
  };
  try {
    await idbRunReadWrite('readwrite', (store) => {
      store.put(payload, id);
    });
    register();
    return { id };
  } catch {
    // IndexedDB unavailable (private mode, disabled) — fall back to localStorage.
  }
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(payload));
    register();
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
  dequeue(id);
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
