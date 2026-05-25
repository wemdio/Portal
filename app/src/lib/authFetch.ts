'use client';

import { supabase } from '@/lib/supabaseClient';

export async function getAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

async function refreshAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session?.access_token) return null;
  return data.session.access_token;
}

/**
 * Fetch wrapper that attaches Supabase Bearer token and retries once on 401
 * by refreshing the session. Throws on non-ok responses (including second 401).
 */
export async function authFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers.set('Authorization', `Bearer ${refreshed}`);
      res = await fetch(url, { ...init, headers });
    }
  }

  return res;
}

/**
 * authFetch + JSON parse + error throw.  Drop-in replacement for the
 * per-module fetcher pattern used across the codebase.
 */
export async function authFetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await authFetch(url, init);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Error ${res.status}`);
  }

  return (await res.json()) as T;
}
