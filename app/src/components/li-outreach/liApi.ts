import { authFetchJson, getAccessToken } from '@/lib/authFetch';

const API = '/api/tools/li-outreach';

export function call<T = unknown>(path: string, method: string, json?: unknown): Promise<T> {
  return authFetchJson<T>(`${API}${path}`, {
    method,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }),
  });
}

export async function upload(path: string, fields: Record<string, string>, file: File): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const fd = new FormData();
  fd.append('file', file);
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
