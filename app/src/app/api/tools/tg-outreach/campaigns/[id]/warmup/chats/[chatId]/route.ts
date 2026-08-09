import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; chatId: string }> };

/** Включить/выключить чат, не удаляя его из списка. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.chats.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id, chatId } = await ctx.params;

      const body = (await req.json().catch(() => ({}))) as { is_active?: boolean };
      if (typeof body.is_active !== 'boolean') return jsonError('Нечего менять', 400);

      const { error } = await auth.supabase
        .from('tg_outreach_warmup_chats')
        .update({ is_active: body.is_active })
        .eq('id', chatId)
        .eq('campaign_id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}

/**
 * Убрать чат из списка.
 *
 * Записи об участии и активностях уходят каскадом. Из самого чата аккаунты при
 * этом не выходят: массовый выход — такой же заметный паттерн, как массовый
 * вход, и делать его молча по нажатию «удалить» нельзя.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.chats.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id, chatId } = await ctx.params;

      const { error } = await auth.supabase
        .from('tg_outreach_warmup_chats')
        .delete()
        .eq('id', chatId)
        .eq('campaign_id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}
