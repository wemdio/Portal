import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { canDeleteProjects } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function getUserFromRequest(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  return { user };
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getUserFromRequest(req);
  if ('error' in auth) return auth.error;

  if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

  const { user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };
  const { id } = await ctx.params;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError) {
    await logError('projects.delete.role.fetch.failed', profileError, { projectId: id }, logMeta);
    return jsonError('Не удалось проверить права пользователя', 500);
  }

  const role = (profile?.role ?? null) as UserRole | null;
  if (!canDeleteProjects(role)) {
    await logError('projects.delete.forbidden', 'Forbidden', { projectId: id, role }, logMeta);
    return jsonError('Нет прав для удаления проекта', 403);
  }

  const { data, error } = await supabaseAdmin
    .from('projects')
    .delete()
    .eq('id', id)
    .select('id');

  if (error) {
    await logError('projects.delete.failed', error, { projectId: id }, logMeta);
    return jsonError('Не удалось удалить проект', 500);
  }

  if (!data || data.length === 0) {
    return jsonError('Проект не найден', 404);
  }

  await logAudit('projects.delete.success', 'Project deleted', { projectId: id }, logMeta);
  return NextResponse.json({ ok: true });
}
