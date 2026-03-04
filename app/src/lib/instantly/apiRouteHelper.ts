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

export function handleInstantlyError(err: unknown) {
  if (err instanceof InstantlyApiError) {
    return jsonError(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
  }
  const message = err instanceof Error ? err.message : 'Instantly API error';
  return jsonError(message, 500);
}

/**
 * Wraps an API handler with auth check and error handling.
 */
export function withAuth(
  handler: (req: NextRequest, user: { id: string; email?: string }, params?: Record<string, string>) => Promise<NextResponse>,
) {
  return async (req: NextRequest, context?: { params: Promise<Record<string, string>> }) => {
    const user = await requireAuth(req);
    if (!user) return jsonError('Необходима авторизация', 401);

    try {
      const params = context?.params ? await context.params : undefined;
      return await handler(req, user, params);
    } catch (err) {
      return handleInstantlyError(err);
    }
  };
}
