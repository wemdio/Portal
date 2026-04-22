'use client';

import { authFetchJson } from '@/lib/authFetch';

export async function instantlyFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  return authFetchJson<T>(`/api/instantly${path}`, init);
}
