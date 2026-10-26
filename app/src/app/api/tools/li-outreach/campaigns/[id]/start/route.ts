import { enrollActiveBase } from '@/lib/liOutreach/enroll';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { id } = await ctx.params;

    // Any authenticated team member can start any campaign (see migration
    // 20260708_0002 — Start/Stop are part of "editing" a campaign, so they
    // follow the widened UPDATE policy).
    const { data: campaign } = await supabaseAdmin
      .from('li_campaigns')
      .select('id,status,lead_list_id,user_id')
      .eq('id', id)
      .maybeSingle<{ id: string; status: string; lead_list_id: string | null; user_id: string }>();
    if (!campaign) return jsonError('Campaign not found', 404);
    if (campaign.status === 'running') return jsonError('Already running', 400);

    // Люди рассылаемой базы — общая функция с воркером: только недостающие пары,
    // уже идущих лидов не трогаем (иначе повторный инвайт, апрель 2026).
    try {
      await enrollActiveBase(supabaseAdmin, id);
    } catch (e) {
      return jsonError(`Не удалось добавить людей базы в рассылку — ${e instanceof Error ? e.message : String(e)}`, 500);
    }

    const { error: updErr } = await supabaseAdmin
      .from('li_campaigns')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updErr) return jsonError(`Не удалось перевести кампанию в статус «запущена» — ${updErr.message}`, 500);

    // Record the lifecycle transition in the per-campaign log so the operator
    // sees in the Logs tab who started the campaign and when, alongside the
    // runtime events that follow.
    await supabaseAdmin.from('li_campaign_logs').insert({
      campaign_id: id,
      level: 'info',
      message: `Кампания запущена пользователем (UI «Старт»). Дальше воркер сам будет тикать каждые ~5 минут.`,
    });

    return NextResponse.json({ ok: true });
  });
}
