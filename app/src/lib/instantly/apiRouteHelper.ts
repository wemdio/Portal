import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';
import { InstantlyApiError } from './errors';

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
export async function fetchUserRole(userId: string, token: string): Promise<string | null> {
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
 * Non-staff users are rejected — clients must use /api/client/* endpoints.
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

    // Только сотрудники, а не «всё, кроме client»: аккаунт без роли проходил бы
    // (аудит 26.10.2026). Та же граница, что у staff-проверки в middleware.
    const role = await fetchUserRole(user.id, token);
    if (!isInternalRole(role as UserRole | null)) {
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
