import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const { data: settings } = await auth.supabase
      .from('li2_settings')
      .select('linkedin_email,llm_api_key,ai_model,legal_accepted')
      .eq('user_id', auth.user.id)
      .maybeSingle();

    if (!settings?.linkedin_email || !settings?.llm_api_key || !settings?.ai_model) {
      return jsonError('Fill LinkedIn and LLM settings before starting OpenOutreach', 400);
    }
    if (!settings.legal_accepted) {
      return jsonError('Accept the LinkedIn automation risk notice before starting', 400);
    }

    const { data: campaign, error: loadError } = await auth.supabase
      .from('li2_campaigns')
      .select('*')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (loadError) return jsonError(loadError.message, 500);
    if (!campaign) return jsonError('Campaign not found', 404);

    const now = new Date().toISOString();
    const { error: updateError } = await auth.supabase
      .from('li2_campaigns')
      .update({ status: 'queued', runtime_status: 'queued_for_openoutreach', updated_at: now })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (updateError) return jsonError(updateError.message, 500);

    const { data: job, error: jobError } = await auth.supabase
      .from('li2_jobs')
      .insert({
        user_id: auth.user.id,
        campaign_id: id,
        type: 'start',
        status: 'pending',
        payload: {
          runtime: 'openoutreach',
          campaign_id: id,
          product_description: campaign.product_description,
          target_market: campaign.target_market,
          campaign_objective: campaign.campaign_objective,
        },
      })
      .select()
      .single();
    if (jobError) return jsonError(jobError.message, 500);

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      level: 'info',
      message: 'OpenOutreach start job queued',
      details: { job_id: job.id },
    });

    return NextResponse.json({ ok: true, job });
  });
}
