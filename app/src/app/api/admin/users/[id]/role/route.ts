import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin, ALL_ROLES } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function getUserFromRequest(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  return { user };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getUserFromRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

  const { user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  const { id: targetUserId } = await ctx.params;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError) {
    await logError('admin.users.role.fetch.failed', profileError, { targetUserId }, logMeta);
    return jsonError('Не удалось проверить права пользователя', 500);
  }

  const actorRole = (profile?.role ?? null) as UserRole | null;
  if (!isAdmin(actorRole)) {
    await logError('admin.users.role.forbidden', 'Forbidden', { targetUserId, actorRole }, logMeta);
    return jsonError('Forbidden', 403);
  }

  const text = await req.text().catch(() => '');
  const body = safeJsonParse<{ role?: unknown }>(text);
  const role = typeof body?.role === 'string' ? (body.role as UserRole) : null;
  if (!role) return jsonError('Missing role', 400);
  if (!ALL_ROLES.includes(role)) return jsonError('Invalid role', 400);

  const { error: updateErr } = await supabaseAdmin
    .from('profiles')
    .update({ role })
    .eq('id', targetUserId);

  if (updateErr) {
    await logError('admin.users.role.update.failed', updateErr, { targetUserId, role }, logMeta);
    return jsonError(updateErr.message || 'Failed to update role', 500);
  }

  await logAudit('admin.users.role.update.success', 'User role updated', { targetUserId, role }, logMeta);
  return NextResponse.json({ ok: true });
}

