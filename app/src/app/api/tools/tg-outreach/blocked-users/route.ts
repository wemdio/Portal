import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { addBlockedUser, listBlockedUsers } from '@/lib/tgOutreach/blockedUsers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.blocked-users.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      try {
        const items = await listBlockedUsers(auth.supabase, auth.user.id);
        return NextResponse.json({ items });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'Не удалось получить чёрный список', 500);
      }
    },
  );
}

interface PostBody {
  tg_user_id?: number | string;
  tg_username?: string | null;
  reason?: string | null;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.blocked-users.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: PostBody;
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const tgUserIdRaw = body.tg_user_id;
      const tgUserId = typeof tgUserIdRaw === 'string' ? Number(tgUserIdRaw) : tgUserIdRaw;
      if (typeof tgUserId !== 'number' || !Number.isFinite(tgUserId) || tgUserId <= 0) {
        return jsonError('tg_user_id обязателен и должен быть положительным числом', 400);
      }

      const tgUsername = typeof body.tg_username === 'string'
        ? body.tg_username.trim().replace(/^@/, '') || null
        : null;
      const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;

      try {
        await addBlockedUser(auth.supabase, auth.user.id, tgUserId, tgUsername, reason);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'Не удалось добавить в чёрный список', 500);
      }

      return NextResponse.json({ ok: true });
    },
  );
}
