import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, checkIsAdmin } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.stop' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { id } = await ctx.params;
    const admin = await checkIsAdmin(auth.user.id);

    let campQ = supabaseAdmin.from('li_campaigns').select('id,status').eq('id', id);
    if (!admin) campQ = campQ.eq('user_id', auth.user.id);

    const { data: campaign } = await campQ.maybeSingle<{ id: string; status: string }>();
    if (!campaign) return jsonError('Campaign not found', 404);

    const { error: updErr } = await supabaseAdmin
      .from('li_campaigns')
      .update({ status: 'stopped', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updErr) return jsonError(`Не удалось перевести кампанию в статус «остановлена» — ${updErr.message}`, 500);

    // Mirror the START log: explicit lifecycle event in the per-campaign log
    // so operators can correlate the silence that follows with this stop.
    await supabaseAdmin.from('li_campaign_logs').insert({
      campaign_id: id,
      level: 'info',
      message: `Кампания остановлена пользователем (UI «Стоп»). Воркер больше не будет её тикать, пока не нажмёте «Старт».`,
    });

    return NextResponse.json({ ok: true });
  });
}
