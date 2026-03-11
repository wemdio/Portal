import { supabase } from '@/lib/supabaseClient';

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? '';
}

export async function tgOutreachFetch<T = unknown>(
  path: string,
  options?: RequestInit & { json?: unknown },
): Promise<T> {
  const token = await getToken();
  const { json, ...rest } = options ?? {};

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(rest.headers as Record<string, string> ?? {}),
  };

  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`/api/tg-outreach${path}`, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}
