import { NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Normalize a proxy URL for storage in tg_outreach_proxies.
 *
 * History: original code force-rewrote `http://` -> `socks5://` because we
 * briefly tried SOCKS as the default transport. Then we built a custom
 * HttpConnectSocket that tunnels MTProto over HTTP CONNECT on port 443
 * (the only path that doesn't trip Infatica's err_protocol DPI on :80 and
 * get our prod IP banned). All running campaigns use `http://` and the
 * SOCKS code path is effectively unused — but the create/import endpoints
 * were still rewriting fresh user input back to `socks5://`, which silently
 * broke every newly-created campaign with `connect timeout (15s)`.
 *
 * New rule:
 *   - leave explicit `http://` / `https://` / `socks4://` / `socks5://` alone
 *   - bare `host:port` defaults to `http://` (the working transport)
 */
export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes('://')) return trimmed;
  return `http://${trimmed}`;
}

export async function authenticateRequest(authHeader: string | null) {
  const token = getBearerToken(authHeader);
  if (!token) return { error: jsonError('Необходима авторизация', 401) } as const;

  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: jsonError('Необходима авторизация', 401) } as const;
    return { supabase, user } as const;
  } catch (error) {
    console.error('[auth] supabase getUser failed', error);
    return { error: jsonError('Сервис авторизации временно недоступен', 503) } as const;
  }
}
