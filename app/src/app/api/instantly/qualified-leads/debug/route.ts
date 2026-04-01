import { NextRequest, NextResponse } from 'next/server';
import * as instantly from '@/lib/instantly/client';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { qualifyReply, getBodyText } from '@/lib/instantly/leadQualifier';
import type { Email } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Diagnostic endpoint — temporarily open (no auth) for browser debugging.
 * GET /api/instantly/qualified-leads/debug          — diagnostic info only
 * GET /api/instantly/qualified-leads/debug?run=true  — run qualification inline with verbose output
 */
export async function GET(req: NextRequest) {
  const shouldRun = req.nextUrl.searchParams.get('run') === 'true';
  const steps: { step: string; result: unknown }[] = [];

  const hasLeadKey = !!process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY;
  const hasBriefKey = !!process.env.OPENROUTER_BRIEF_API_KEY;
  const apiKey = (process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ?? process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim();
  const model = process.env.INSTANTLY_LEAD_QUAL_MODEL ?? 'policy/gemini-flash';

  steps.push({
    step: '1. ENV keys',
    result: {
      OPENROUTER_INSTANTLY_LEAD_API_KEY: hasLeadKey ? `set (${process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY!.slice(0, 8)}...)` : 'NOT SET',
      OPENROUTER_BRIEF_API_KEY: hasBriefKey ? `set (${process.env.OPENROUTER_BRIEF_API_KEY!.slice(0, 8)}...)` : 'NOT SET',
      INSTANTLY_LEAD_QUAL_MODEL: model,
      effective_key: hasLeadKey ? 'LEAD key' : hasBriefKey ? 'BRIEF key (fallback)' : 'NONE',
    },
  });

  if (!apiKey) {
    steps.push({ step: 'STOP', result: 'No API key — cannot run' });
    return NextResponse.json({ steps });
  }

  steps.push({
    step: '2. supabaseAdmin',
    result: supabaseAdmin ? 'OK' : 'NOT CONFIGURED',
  });

  if (!supabaseAdmin) {
    return NextResponse.json({ steps });
  }
  const db = supabaseAdmin;

  const { data: prefs, error: prefsErr } = await db
    .from('user_instantly_campaign_preferences')
    .select('user_id, campaign_id');

  steps.push({
    step: '3. Campaign preferences',
    result: prefsErr
      ? { error: prefsErr.message }
      : { count: prefs?.length ?? 0, campaigns: prefs },
  });

  const campaignIds = [...new Set((prefs ?? []).map((r: { campaign_id: string }) => r.campaign_id))];
  if (campaignIds.length === 0) {
    steps.push({ step: 'STOP', result: 'No subscribed campaigns' });
    return NextResponse.json({ steps });
  }

  // Fetch reply emails from Instantly
  type EmailWithCampaign = Email & { _cid: string };
  const replyEmails: EmailWithCampaign[] = [];

  for (const cid of campaignIds) {
    try {
      const res = await instantly.listEmails({ campaign_id: cid, limit: 30 });
      const emails = res.items ?? [];
      const replies = emails.filter((e) => (e.ue_type ?? 1) === 2);
      steps.push({
        step: `4. Instantly campaign ${cid}`,
        result: {
          total: emails.length,
          replies: replies.length,
          reply_ids: replies.map((e) => ({ id: e.id, from: e.from_address_email })),
        },
      });
      for (const r of replies) {
        replyEmails.push({ ...r, _cid: cid } as EmailWithCampaign);
      }
    } catch (err) {
      steps.push({
        step: `4. Instantly campaign ${cid}`,
        result: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  if (replyEmails.length === 0) {
    steps.push({ step: 'STOP', result: 'No reply emails (ue_type=2) found' });
    return NextResponse.json({ steps });
  }

  // Deduplication
  const emailIds = replyEmails.map((e) => e.id).filter(Boolean);
  const { data: existing } = await db
    .from('instantly_lead_qualifications')
    .select('instantly_email_id')
    .in('instantly_email_id', emailIds);

  const existingIds = new Set(
    (existing ?? []).map((r: { instantly_email_id: string }) => r.instantly_email_id),
  );
  const newReplies = replyEmails.filter((e) => e.id && !existingIds.has(e.id));

  steps.push({
    step: '5. Deduplication',
    result: {
      total_replies: replyEmails.length,
      already_processed: existingIds.size,
      new_to_process: newReplies.length,
    },
  });

  if (newReplies.length === 0) {
    steps.push({ step: 'STOP', result: 'All replies already processed' });
    return NextResponse.json({ steps });
  }

  if (!shouldRun) {
    steps.push({ step: 'INFO', result: `${newReplies.length} replies ready. Add ?run=true to qualify them.` });

    const { data: existingQuals, error: existErr } = await db
      .from('instantly_lead_qualifications')
      .select('id, instantly_email_id, status, lead_email, error_message, ai_reason, ai_confidence, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    steps.push({
      step: '6. Existing qualifications (latest 10)',
      result: existErr ? { error: existErr.message } : existingQuals,
    });

    return NextResponse.json({ steps });
  }

  // Run qualification
  let processed = 0;
  for (const reply of newReplies.slice(0, 5)) {
    const leadEmail = reply.from_address_email ?? '';
    const campaignId = reply.campaign_id ?? reply._cid;

    if (!campaignId || !leadEmail) {
      steps.push({ step: `6. Qualify ${reply.id}`, result: 'SKIP — no campaignId or email' });
      continue;
    }

    try {
      const result = await qualifyReply(campaignId, leadEmail, reply.thread_id, {
        apiKey,
        model,
      });

      const replyText = result.threadContext
        ? getBodyText(result.threadContext.replyEmail.body)
        : getBodyText(reply.body);
      const lastOutText = result.threadContext?.lastOutbound
        ? getBodyText(result.threadContext.lastOutbound.body)
        : null;

      let status: string;
      if (result.needsReview) status = 'needs_review';
      else if (result.isLead) status = 'lead';
      else status = 'not_lead';

      const { error: insertErr } = await db.from('instantly_lead_qualifications').insert({
        campaign_id: campaignId,
        lead_email: leadEmail,
        thread_id: reply.thread_id,
        reply_subject: reply.subject ?? null,
        reply_preview: replyText.slice(0, 300) || null,
        reply_body: replyText || null,
        last_outbound_preview: lastOutText?.slice(0, 300) ?? null,
        last_outbound_ue_type: result.threadContext?.lastOutbound?.ue_type ?? null,
        status,
        proposal_seen: result.proposalSeen,
        interest_signals: result.interestSignals,
        ai_reason: result.reason,
        ai_confidence: result.confidence,
        instantly_email_id: reply.id,
        reply_timestamp: reply.timestamp_email ?? null,
      });

      steps.push({
        step: `6. Qualified ${leadEmail}`,
        result: insertErr
          ? { status, confidence: result.confidence, db_error: insertErr.message }
          : { status, confidence: result.confidence, reason: result.reason },
      });
      if (!insertErr) processed++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      steps.push({ step: `6. FAILED ${leadEmail}`, result: errMsg });

      try {
        await db.from('instantly_lead_qualifications').insert({
          campaign_id: campaignId,
          lead_email: leadEmail,
          thread_id: reply.thread_id,
          instantly_email_id: reply.id,
          status: 'error',
          error_message: errMsg,
        });
      } catch { /* ignore insert failure */ }
    }
  }

  steps.push({ step: '7. Summary', result: { processed, total_new: newReplies.length } });
  return NextResponse.json({ steps });
}
