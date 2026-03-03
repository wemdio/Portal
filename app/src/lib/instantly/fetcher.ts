'use client';

import { supabase } from '@/lib/supabaseClient';

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

export async function instantlyFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`/api/instantly${path}`, { ...init, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Error ${res.status}`);
  }

  return (await res.json()) as T;
}
