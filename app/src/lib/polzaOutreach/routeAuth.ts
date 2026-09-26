/**
 * Авторизация API-роутов английского автоаутрича: Bearer-токен пользователя →
 * Supabase-клиент с его правами (RLS), как в соседних роутах
 * api/parsers/polza-outreach. Нужна роутам цепочек и настроек: их три, и
 * одинаковый разбор токена в каждом разъехался бы при первой правке.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function authed(
  req: NextRequest,
): Promise<{ supabase: SupabaseClient; user: User } | { error: NextResponse }> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };
  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { error: jsonError('Unauthorized', 401) };
    return { supabase, user: data.user };
  } catch {
    return { error: jsonError('Unauthorized', 401) };
  }
}
