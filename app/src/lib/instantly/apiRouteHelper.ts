import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { InstantlyApiError } from './client';

export const dynamic = 'force-dynamic';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireAuth(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * Fetch the caller's role from profiles. Returns null on any failure.
 */
async function fetchUserRole(userId: string, token: string): Promise<string | null> {
  const supabase = createAuthedSupabaseClient(token);
  const { data } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();
  return data?.role ?? null;
}

export function handleInstantlyError(err: unknown) {
  if (err instanceof InstantlyApiError) {
    return jsonError(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
  }
  const message = err instanceof Error ? err.message : 'Instantly API error';
  return jsonError(message, 500);
}

/**
 * Wraps an API handler with auth check, internal-role guard, and error handling.
 * Client users are rejected — they must use /api/client/* endpoints.
 */
export function withAuth(
  handler: (req: NextRequest, user: { id: string; email?: string }, params?: Record<string, string>) => Promise<NextResponse>,
) {
  return async (req: NextRequest, context?: { params: Promise<Record<string, string>> }) => {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Необходима авторизация', 401);

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Необходима авторизация', 401);

    const role = await fetchUserRole(user.id, token);
    if (role === 'client') {
      return jsonError('Доступ запрещён. Используйте клиентский кабинет.', 403);
    }

    try {
      const params = context?.params ? await context.params : undefined;
      return await handler(req, user, params);
    } catch (err) {
      return handleInstantlyError(err);
    }
  };
}
