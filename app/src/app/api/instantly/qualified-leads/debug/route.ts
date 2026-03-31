import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Diagnostic endpoint: runs one polling cycle inline and returns step-by-step results.
 * GET /api/instantly/qualified-leads/debug
 */
export const GET = withAuth(async () => {
  const steps: { step: string; result: unknown }[] = [];

  // Step 1: Check env keys
  const hasLeadKey = !!process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY;
  const hasBriefKey = !!process.env.OPENROUTER_BRIEF_API_KEY;
  const model = process.env.INSTANTLY_LEAD_QUAL_MODEL ?? 'policy/gemini-flash (default)';
  steps.push({
    step: '1. ENV keys',
    result: {
      OPENROUTER_INSTANTLY_LEAD_API_KEY: hasLeadKey ? `set (${process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY!.slice(0, 8)}...)` : 'NOT SET',
      OPENROUTER_BRIEF_API_KEY: hasBriefKey ? `set (${process.env.OPENROUTER_BRIEF_API_KEY!.slice(0, 8)}...)` : 'NOT SET',
      INSTANTLY_LEAD_QUAL_MODEL: model,
      effective_key: hasLeadKey ? 'LEAD key' : hasBriefKey ? 'BRIEF key (fallback)' : 'NONE — worker will skip!',
    },
  });

  // Step 2: Check supabaseAdmin
  steps.push({
    step: '2. supabaseAdmin',
    result: supabaseAdmin ? 'OK' : 'NOT CONFIGURED — worker cannot run',
  });

  if (!supabaseAdmin) {
    return NextResponse.json({ steps });
  }

  // Step 3: Check campaign preferences
  const { data: prefs, error: prefsErr } = await supabaseAdmin
    .from('user_instantly_campaign_preferences')
    .select('user_id, campaign_id');

  steps.push({
    step: '3. Campaign preferences (all users)',
    result: prefsErr
      ? { error: prefsErr.message }
      : { count: prefs?.length ?? 0, campaigns: prefs },
  });

  const campaignIds = [...new Set((prefs ?? []).map((r: { campaign_id: string }) => r.campaign_id))];
  if (campaignIds.length === 0) {
    steps.push({ step: 'STOP', result: 'No subscribed campaigns — worker has nothing to poll' });
    return NextResponse.json({ steps });
  }

  // Step 4: Fetch emails from Instantly for each campaign
  for (const cid of campaignIds) {
    try {
      const res = await instantly.listEmails({ campaign_id: cid, limit: 10 });
      const emails = res.items ?? [];
      const replies = emails.filter((e) => (e.ue_type ?? 1) === 2);
      steps.push({
        step: `4. Instantly emails for campaign ${cid}`,
        result: {
          total_emails: emails.length,
          replies_ue_type_2: replies.length,
          email_types: emails.map((e) => ({
            id: e.id,
            ue_type: e.ue_type,
            from: e.from_address_email,
            subject: e.subject?.slice(0, 60),
          })),
        },
      });
    } catch (err) {
      steps.push({
        step: `4. Instantly emails for campaign ${cid}`,
        result: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Step 5: Check existing qualifications
  const { data: existing, error: existErr } = await supabaseAdmin
    .from('instantly_lead_qualifications')
    .select('id, instantly_email_id, status, lead_email')
    .order('created_at', { ascending: false })
    .limit(10);

  steps.push({
    step: '5. Existing qualifications (latest 10)',
    result: existErr ? { error: existErr.message } : existing,
  });

  return NextResponse.json({ steps });
});
