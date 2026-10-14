/**
 * «Отправить в CRM» по одному диалогу: повтор после сбоя или первый раз —
 * для лидов, переданных до того, как у кампании включили CRM.
 *
 * Настройки берём текущие из кампании: если сбой был в этапе или токене,
 * исправленное подхватится. Карточку — ту, что ушла менеджеру, если она есть.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { enqueueCrmPush } from '@/lib/tgOutreach/crmPush';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.crm-push.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Сервер не настроен (service role)', 500);
      const { id } = await ctx.params;

      const { data: dialog, error: dlgErr } = await auth.supabase
        .from('tg_outreach_dialogs')
        .select('id, campaign_id')
        .eq('id', id)
        .maybeSingle();
      if (dlgErr) return jsonError(dlgErr.message, 500);
      if (!dialog) return jsonError('Диалог не найден', 404);
      const campaignId = (dialog as { campaign_id: string }).campaign_id;

      // Карточка: из прошлой попытки CRM, иначе — ушедшая менеджеру передача.
      const [{ data: lastPush }, { data: lastForward }] = await Promise.all([
        supabaseAdmin
          .from('tg_outreach_crm_pushes')
          .select('message_text')
          .eq('dialog_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from('tg_outreach_lead_forwards')
          .select('message_text')
          .eq('dialog_id', id)
          .eq('kind', 'lead')
          .in('status', ['sent', 'failed'])
          .order('requested_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      const messageText = (lastPush as { message_text?: string } | null)?.message_text
        || (lastForward as { message_text?: string } | null)?.message_text
        || null;

      let reason = '';
      const result = await enqueueCrmPush(supabaseAdmin, {
        campaignId,
        dialogId: id,
        messageText,
        log: (_level, msg) => { reason = msg; },
      });
      if (result === 'disabled') return jsonError('В кампании выключена передача в CRM — включите её в настройках', 400);
      if (result === 'duplicate') return jsonError('Этот лид уже в CRM или в очереди на отправку', 409);
      if (result === 'error') return jsonError(reason || 'Не удалось поставить в очередь CRM', 500);
      return NextResponse.json({ ok: true });
    },
  );
}
