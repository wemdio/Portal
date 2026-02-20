import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
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
    await logError('admin.users.password.role.fetch.failed', profileError, { targetUserId }, logMeta);
    return jsonError('Не удалось проверить права пользователя', 500);
  }

  const role = (profile?.role ?? null) as UserRole | null;
  if (!isAdmin(role)) {
    await logError('admin.users.password.forbidden', 'Forbidden', { targetUserId, role }, logMeta);
    return jsonError('Forbidden', 403);
  }

  const text = await req.text().catch(() => '');
  const body = safeJsonParse<{ password?: unknown }>(text);
  const password = typeof body?.password === 'string' ? body.password : '';

  const trimmed = password.trim();
  if (!trimmed) return jsonError('Missing password', 400);
  if (trimmed.length < 8) return jsonError('Password must be at least 8 characters', 400);
  // bcrypt truncates at 72 bytes; keep a safe upper bound for UI.
  if (trimmed.length > 72) return jsonError('Password must be at most 72 characters', 400);

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, { password: trimmed });
  if (updateErr) {
    await logError('admin.users.password.update.failed', updateErr, { targetUserId }, logMeta);
    return jsonError(updateErr.message || 'Failed to update password', 500);
  }

  await logAudit('admin.users.password.update.success', 'User password updated', { targetUserId }, logMeta);
  return NextResponse.json({ ok: true });
}

