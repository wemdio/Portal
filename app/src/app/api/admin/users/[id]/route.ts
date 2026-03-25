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

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const logMeta = { userId: user.id };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isAdmin((profile?.role ?? null) as UserRole | null)) {
    return jsonError('Forbidden', 403);
  }

  const { id: targetUserId } = await ctx.params;

  if (targetUserId === user.id) {
    return jsonError('Нельзя удалить самого себя', 400);
  }

  const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(targetUserId);
  if (authErr) {
    await logError('admin.users.delete.auth.failed', authErr, { targetUserId }, logMeta);
    return jsonError('Ошибка удаления пользователя', 500);
  }

  await logAudit('admin.users.delete.success', 'User deleted (auth + profile)', { targetUserId }, logMeta);
  return NextResponse.json({ ok: true });
}
