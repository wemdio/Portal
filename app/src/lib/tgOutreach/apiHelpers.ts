import { NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
