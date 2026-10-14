/**
 * Блокировка входа пользователя.
 *
 * Клиент английского кабинета (profiles.role = 'client' AND market = 'eng'):
 * POST идёт в engAccountBlock (грузится динамически только в этой ветке) —
 * блокировка останавливает ВСЁ (решение владельца 12.10.2026): отметка
 * блокировки, выключатель отправки, пауза кампаний, бан и отзыв сессий,
 * работа проектов, «Daily top-up», письма клиенту; ответ — 200 с отчётом
 * `eng_stop` (что не остановилось — красным), повторное нажатие доставляет
 * остановку там, где она не дошла (и тому, кто забанен без отметки).
 * Разблокировка (`eng_unblock`) сначала повторяет всю остановку и снимает бан,
 * только если она подтверждена: не подтверждена (или по ходу нажали
 * «Заблокировать», или это не удалось проверить) — 200 с `blocked: true` и
 * отчётом; бан снят, а «Заблокировать», нажатое по ходу, сдвинуло отметку —
 * 200 с `blocked: true` (бан поставлен снова, отчёт говорит, легло ли); бан не
 * снялся — 500; клиент не заблокирован — 409, ничего не тронуто; не
 * прочиталось, заблокирован ли, — 503.
 * Остальные пользователи — прежний путь: бан и отзыв сессий, те же тексты.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

function isBlocked(bannedUntil: string | null | undefined): boolean {
  if (!bannedUntil) return false;
  const timestamp = Date.parse(bannedUntil);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function getTargetProfile(targetUserId: string, withMarket = false) {
  if (!supabaseAdmin) return { profile: null, error: { message: 'Server misconfigured' } };
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(withMarket ? 'is_demo,is_api_robot,role,market' : 'is_demo,is_api_robot')
    .eq('id', targetUserId)
    .maybeSingle();
  return { profile: data as { is_demo?: unknown; is_api_robot?: unknown; role?: unknown; market?: unknown } | null, error };
}

/** ENG-клиент: блокировка с полной остановкой / разблокировка: остановка, затем только вход. */
async function engBlockResponse(targetUserId: string, blocked: boolean, staffUserId: string) {
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { blockHeEngAccount, unblockHeEngAccount } = await import('@/lib/hypothesisEngine/engAccountBlock');
  const { supabaseInstantly } = await import('@/lib/supabaseInstantly');
  if (blocked) {
    const result = await blockHeEngAccount({
      portalDb: supabaseAdmin,
      instantlyDb: supabaseInstantly ?? null,
      userId: targetUserId,
      staffUserId,
    });
    return NextResponse.json({
      ok: true,
      blocked: true,
      bannedUntil: result.bannedUntil,
      eng_stop: {
        complete: result.report.complete,
        ...(result.error ? { error: result.error } : {}),
        lines: result.lines,
        report: result.report,
      },
    });
  }
  const result = await unblockHeEngAccount({
    portalDb: supabaseAdmin,
    instantlyDb: supabaseInstantly ?? null,
    userId: targetUserId,
    staffUserId,
  });
  if (result.kind === 'not_blocked') {
    return jsonError('Клиент не заблокирован — разблокировать нечего. Обновите карточку.', 409);
  }
  if (result.kind === 'standing_unread') {
    return jsonError('Не удалось проверить, заблокирован ли клиент, — нажмите «Разблокировать» ещё раз.', 503);
  }
  const engUnblock = {
    complete: result.report.complete,
    ...(result.error ? { error: result.error } : {}),
    lines: result.lines,
    report: result.report,
  };
  if (result.report.ban === 'failed') {
    return NextResponse.json({ error: result.error ?? 'Ошибка разблокировки пользователя', eng_unblock: engUnblock }, { status: 500 });
  }
  if (result.report.ban === 'kept' || result.report.marker === 'superseded') {
    // Бан на месте (или поставлен снова) — почему, в отчёте.
    return NextResponse.json({ ok: true, blocked: true, eng_unblock: engUnblock });
  }
  return NextResponse.json({ ok: true, blocked: false, bannedUntil: result.bannedUntil, eng_unblock: engUnblock });
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

  const { profile, error: profileError } = await getTargetProfile(targetUserId, true);
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
  if (profile.role === 'client' && profile.market === 'eng') {
    return engBlockResponse(targetUserId, body.blocked, auth.auth.user.id);
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
