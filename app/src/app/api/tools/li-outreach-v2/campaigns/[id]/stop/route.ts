import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.stop' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const { error } = await auth.supabase
      .from('li2_campaigns')
      .update({ status: 'stopped', runtime_status: 'stop_requested', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (error) return jsonError(error.message, 500);

    await auth.supabase.from('li2_jobs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      type: 'stop',
      status: 'pending',
      payload: { runtime: 'openoutreach', campaign_id: id },
    });
    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      level: 'warning',
      message: 'OpenOutreach stop job queued',
    });

    return NextResponse.json({ ok: true });
  });
}
