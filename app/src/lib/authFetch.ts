'use client';

import { supabase } from '@/lib/supabaseClient';

/**
 * Thrown by authFetchJson when our backend returns 401 AND our one-shot
 * refresh attempt also failed. Callers (forms) can detect this and offer
 * a friendly "open login in new tab" recovery — without resetting the
 * form, so the user's typed content is preserved.
 */
export class AuthExpiredError extends Error {
  readonly code = 'AUTH_EXPIRED' as const;
  constructor() {
    super('Сессия истекла. Откройте страницу входа в новой вкладке — текст в форме сохранится.');
    this.name = 'AuthExpiredError';
  }
}

export function isAuthExpiredError(err: unknown): err is AuthExpiredError {
  return err instanceof Error && (err as { code?: unknown }).code === 'AUTH_EXPIRED';
}

export async function getAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

async function refreshAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session?.access_token) {
    // Залогируем причину провала рефреша — в текущем виде мы тихо
    // отдавали "Unauthorized" в форму, и было непонятно, почему refresh
    // не сработал. Когда юзер сообщит, что снова поймал AuthExpiredError,
    // у нас будет конкретный текст ошибки от Supabase в браузерной консоли.
    console.warn('[authFetch] refreshSession failed', {
      message: error?.message ?? 'no session in response',
      status: (error as { status?: number } | null)?.status,
    });
    return null;
  }
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
    if (res.status === 401) {
      // Если мы дошли сюда с 401 — значит и оригинальный запрос, и retry
      // после refreshSession (см. authFetch выше) вернули 401. Сессия
      // действительно умерла, и для UI это отдельный сценарий: нужно
      // предложить вход без сноса формы.
      throw new AuthExpiredError();
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Error ${res.status}`);
  }

  return (await res.json()) as T;
}
