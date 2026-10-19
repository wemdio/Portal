import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import type { DialogMessage } from '@/lib/tgOutreach/types';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Удалить в Telegram сообщение, которое написал наш аккаунт. Сам запрос только
 * ставит задачу воркеру: сессии Telegram живут у него, а пока кампания идёт, её
 * аккаунты заняты циклом — как и у refetch, второй клиент на той же сессии нельзя.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.by-id.delete-message.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase, user } = auth;
      const { id } = await ctx.params;

      let body: { timestamp?: string | null; content?: string };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }
      const content = body.content?.trim();
      if (!content) return jsonError('content обязателен', 400);

      const { data: dialog } = await supabase
        .from('tg_outreach_dialogs')
        .select('id, campaign_id, messages')
        .eq('id', id)
        .single();
      if (!dialog) return jsonError('Диалог не найден', 404);

      const ours = ((dialog.messages ?? []) as DialogMessage[]).some(
        (m) => m.role === 'assistant' && (m.content ?? '').trim() === content,
      );
      if (!ours) return jsonError('Такого сообщения от нашего аккаунта в диалоге нет', 404);

      const { data: campaign } = await supabase
        .from('tg_outreach_campaigns')
        .select('status')
        .eq('id', dialog.campaign_id)
        .single();
      if (campaign?.status === 'running') {
        return jsonError('Кампания запущена — остановите её, чтобы удалить сообщение в Telegram', 409);
      }

      const { data, error } = await supabase
        .from('tg_outreach_jobs')
        .insert({
          campaign_id: dialog.campaign_id,
          user_id: user.id,
          action: 'delete_messages',
          payload: { dialog_id: id, timestamp: body.timestamp ?? null, content },
        })
        .select()
        .single();
      if (error) return jsonError(error.message, 500);

      return NextResponse.json(data, { status: 201 });
    },
  );
}
