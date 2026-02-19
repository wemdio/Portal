'use client';

export type PendingDbImportV1 = {
  version: 1;
  title: string;
  rows: string[][];
  created_at: string;
};

const STORAGE_PREFIX = 'portal:db-import:v1:';

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

export function writePendingDbImport(input: { title: string; rows: string[][] }): { id: string } {
  const id = createId();
  const payload: PendingDbImportV1 = {
    version: 1,
    title: input.title,
    rows: input.rows,
    created_at: new Date().toISOString(),
  };
  window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(payload));
  return { id };
}

export function readPendingDbImport(id: string): PendingDbImportV1 | null {
  const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${id}`);
  const parsed = safeJsonParse<PendingDbImportV1>(raw);
  if (!parsed) return null;
  if (parsed.version !== 1) return null;
  if (typeof parsed.title !== 'string') return null;
  if (!Array.isArray(parsed.rows)) return null;
  return parsed;
}

export function deletePendingDbImport(id: string) {
  window.localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
}

export function buildDatabasesImportUrl(id: string) {
  return `/tools/databases?import=${encodeURIComponent(id)}`;
}

