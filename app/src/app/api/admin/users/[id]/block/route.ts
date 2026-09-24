import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function isBlocked(bannedUntil: string | null | undefined): boolean {
  if (!bannedUntil) return false;
  const timestamp = Date.parse(bannedUntil);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function getTargetProfile(targetUserId: string) {
  if (!supabaseAdmin) return { profile: null, error: { message: 'Server misconfigured' } };
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('is_demo,is_api_robot')
    .eq('id', targetUserId)
    .maybeSingle();
  return { profile: data, error };
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id: targetUserId } = await ctx.params;
  const [{ profile, error: profileError }, { data, error: userError }] = await Promise.all([
    getTargetProfile(targetUserId),
    supabaseAdmin.auth.admin.getUserById(targetUserId),
  ]);

  if (profileError) {
    await logError('admin.users.block.profile.fetch.failed', profileError, { targetUserId }, {
      userId: auth.auth.user.id,
    });
    return jsonError('Не удалось получить статус пользователя', 500);
  }
  if (userError || !data.user) {
    return jsonError('Пользователь не найден', 404);
  }

  const bannedUntil = data.user.banned_until ?? null;
  return NextResponse.json({
    blocked: isBlocked(bannedUntil),
    bannedUntil,
    protected: profile?.is_demo === true || profile?.is_api_robot === true,
  });
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id: targetUserId } = await ctx.params;
  if (targetUserId === auth.auth.user.id) {
    return jsonError('Нельзя заблокировать самого себя', 400);
  }

  const body = await req.json().catch(() => null) as { blocked?: unknown } | null;
  if (typeof body?.blocked !== 'boolean') {
    return jsonError('Поле blocked должно быть boolean', 400);
  }

  const { profile, error: profileError } = await getTargetProfile(targetUserId);
  if (profileError) {
    await logError('admin.users.block.profile.fetch.failed', profileError, { targetUserId }, {
      userId: auth.auth.user.id,
    });
    return jsonError('Не удалось проверить пользователя', 500);
  }
  if (!profile) return jsonError('Пользователь не найден', 404);
  if (profile.is_demo === true || profile.is_api_robot === true) {
    return jsonError('Системный аккаунт нельзя блокировать', 400);
  }

  const blocked = body.blocked;
  const { data, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
    targetUserId,
    { ban_duration: blocked ? '876000h' : 'none' },
  );
  if (updateError) {
    await logError('admin.users.block.auth.failed', updateError, { targetUserId, blocked }, {
      userId: auth.auth.user.id,
    });
    return jsonError(blocked ? 'Ошибка блокировки пользователя' : 'Ошибка разблокировки пользователя', 500);
  }

  if (blocked) {
    const { error: revokeError } = await supabaseAdmin.rpc('admin_revoke_user_sessions', {
      target_user_id: targetUserId,
    });
    if (revokeError) {
      await logError('admin.users.block.sessions.failed', revokeError, { targetUserId }, {
        userId: auth.auth.user.id,
      });
      return jsonError('Пользователь заблокирован, но активные сессии не отозваны', 500);
    }
  }

  const bannedUntil = data.user?.banned_until ?? null;
  await logAudit(
    blocked ? 'admin.users.block.success' : 'admin.users.unblock.success',
    blocked ? 'User blocked and sessions revoked' : 'User unblocked',
    { targetUserId, bannedUntil },
    { userId: auth.auth.user.id },
  );
  return NextResponse.json({ ok: true, blocked, bannedUntil });
}
