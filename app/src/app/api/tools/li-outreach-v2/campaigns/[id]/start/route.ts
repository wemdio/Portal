import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const requestyKey = (process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '').trim();
    if (!requestyKey) {
      return jsonError('OPENROUTER_LI_OUTREACH_API_KEY is not configured on server', 500);
    }

    const { data: settings } = await auth.supabase
      .from('li2_settings')
      .select('linkedin_email,linkedin_password,legal_accepted')
      .eq('user_id', auth.user.id)
      .maybeSingle();

    if (!settings?.linkedin_email || !settings?.linkedin_password) {
      return jsonError('Fill LinkedIn settings before starting OpenOutreach', 400);
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
          // Stored as a single textarea string ("one URL per line"); parse
          // into an array of trimmed non-empty URLs for the runtime. These are
          // starting seeds the agent uses to bootstrap discovery (1st-degree
          // connections, "people also viewed", etc.).
          seed_profile_urls: String(campaign.seed_profile_urls ?? '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
          // Inverse of TG's sleep_periods: the runtime should ONLY send invites
          // and replies during these windows (local time = UTC + timezone_offset).
          schedule: {
            working_hours: Array.isArray(campaign.working_hours)
              ? campaign.working_hours
              : ['09:00-18:00'],
            timezone_offset: Number.isFinite(Number(campaign.timezone_offset))
              ? Number(campaign.timezone_offset)
              : 0,
          },
          llm: {
            provider: 'openai_compatible',
            api_base: 'https://router.requesty.ai/v1',
            api_key_env: 'OPENROUTER_LI_OUTREACH_API_KEY',
            model: 'openai/gpt-4o-mini',
          },
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
