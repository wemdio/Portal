import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import { purgeUserOwnedJobs } from '@/lib/admin/purgeUserOwnedJobs';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * PATCH — карточка пользователя: ФИО и почта.
 *
 * Почта меняется В ДВУХ местах: в профиле (его видно в интерфейсе) и в учётной
 * записи Supabase (по ней человек входит). Если поменять только профиль, в
 * списке появится новый адрес, а войти можно будет по старому — и разбираться
 * в этом придётся уже по жалобе «не пускает». Поэтому сначала меняем вход, и
 * только при успехе — профиль: расходящийся адрес хуже невыполненной правки.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const logMeta = { userId: user.id };

  const { data: actor } = await supabaseAdmin
    .from('profiles').select('role').eq('id', user.id).single();
  if (!isAdmin((actor?.role ?? null) as UserRole | null)) return jsonError('Forbidden', 403);

  const { id: targetUserId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { full_name?: unknown; email?: unknown }
    | null;
  if (!body) return jsonError('Невалидный JSON', 400);

  const patch: { full_name?: string; email?: string } = {};

  if (body.full_name !== undefined) {
    const fullName = String(body.full_name).trim();
    if (!fullName) return jsonError('Имя не может быть пустым', 400);
    if (fullName.length > 200) return jsonError('Имя длиннее 200 символов', 400);
    patch.full_name = fullName;
  }

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return jsonError('Почта выглядит некорректно', 400);
    patch.email = email;
  }

  if (!Object.keys(patch).length) return jsonError('Нечего менять', 400);

  if (patch.email) {
    // Занятый адрес Supabase отклонит сам, но с невнятной формулировкой —
    // проверяем заранее, чтобы администратор увидел, кем адрес занят.
    const { data: taken } = await supabaseAdmin
      .from('profiles').select('id').eq('email', patch.email).neq('id', targetUserId).maybeSingle();
    if (taken) return jsonError('Эта почта уже привязана к другому пользователю', 409);

    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
      email: patch.email,
      email_confirm: true,
    });
    if (authError) {
      await logError('admin.users.profile.auth.email.failed', authError, { targetUserId }, logMeta);
      return jsonError(`Не удалось сменить почту для входа: ${authError.message}`, 500);
    }
  }

  const { error } = await supabaseAdmin.from('profiles').update(patch).eq('id', targetUserId);
  if (error) {
    await logError('admin.users.profile.update.failed', error, { targetUserId }, logMeta);
    return jsonError('Не удалось сохранить карточку пользователя', 500);
  }

  await logAudit('admin.users.profile.updated', 'User profile updated', {
    targetUserId,
    changed: Object.keys(patch),
  }, logMeta);

  return NextResponse.json({ ok: true });
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

  const purgeErr = await purgeUserOwnedJobs(supabaseAdmin, targetUserId);
  if (purgeErr) {
    await logError('admin.users.delete.purge.failed', purgeErr, { targetUserId }, logMeta);
    return jsonError('Ошибка удаления пользователя', 500);
  }

  const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(targetUserId);
  if (authErr) {
    await logError('admin.users.delete.auth.failed', authErr, { targetUserId }, logMeta);
    return jsonError('Ошибка удаления пользователя', 500);
  }

  await logAudit('admin.users.delete.success', 'User deleted (auth + profile)', { targetUserId }, logMeta);
  return NextResponse.json({ ok: true });
}
