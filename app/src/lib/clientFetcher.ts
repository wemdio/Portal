'use client';

import { authFetchJson } from '@/lib/authFetch';

export async function clientApiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return authFetchJson<T>(`/api/client${path}`, init);
}
