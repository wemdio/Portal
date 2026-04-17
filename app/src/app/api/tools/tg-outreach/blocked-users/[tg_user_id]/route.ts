import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { removeBlockedUser } from '@/lib/tgOutreach/blockedUsers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ tg_user_id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.blocked-users.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { tg_user_id: tgUserIdRaw } = await ctx.params;
      const tgUserId = Number(tgUserIdRaw);
      if (!Number.isFinite(tgUserId) || tgUserId <= 0) {
        return jsonError('Некорректный tg_user_id', 400);
      }

      try {
        await removeBlockedUser(auth.supabase, auth.user.id, tgUserId);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'Не удалось удалить из чёрного списка', 500);
      }

      return NextResponse.json({ ok: true });
    },
  );
}
