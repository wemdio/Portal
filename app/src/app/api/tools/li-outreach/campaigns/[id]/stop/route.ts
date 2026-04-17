import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.stop' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { id } = await ctx.params;

    const { data: campaign } = await supabaseAdmin
      .from('li_campaigns')
      .select('id,status')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle<{ id: string; status: string }>();
    if (!campaign) return jsonError('Campaign not found', 404);

    await supabaseAdmin
      .from('li_campaigns')
      .update({ status: 'stopped', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', auth.user.id);

    return NextResponse.json({ ok: true });
  });
}
