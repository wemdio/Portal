import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import { qualifyReply, getBodyText } from './leadQualifier';
import * as instantly from './client';
import type { Email } from './types';

const EMAILS_PER_CAMPAIGN = 30;
const MAX_QUALIFY_PER_TICK = 5;
const API_KEY = () =>
  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  '';
const MODEL = process.env.INSTANTLY_LEAD_QUAL_MODEL ?? 'policy/gemini-flash';

function workerLog(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: unknown,
) {
  const line = `[instantly-lead-qual][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

/**
 * Returns the distinct set of campaign IDs that at least one user has
 * selected in their lead-feed preferences. Only these campaigns are polled.
 */
async function getSubscribedCampaignIds(): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('user_instantly_campaign_preferences')
    .select('campaign_id');

  if (error || !data) return [];

  return [...new Set(data.map((r: { campaign_id: string }) => r.campaign_id))];
}

/**
 * Main polling function: fetches recent reply emails from the Instantly API
 * **only for campaigns that specialists have subscribed to**, deduplicates
 * against already-processed records, and qualifies new ones via AI.
 * Returns the number of new replies qualified.
 */
export async function pollAndQualifyReplies(): Promise<number> {
  if (!supabaseAdmin) {
    workerLog('warn', 'supabaseAdmin not configured — skipping');
    return 0;
  }
  const db = supabaseAdmin;

  const apiKey = API_KEY();
  if (!apiKey) {
    workerLog('warn', 'No AI API key (OPENROUTER_INSTANTLY_LEAD_API_KEY / OPENROUTER_BRIEF_API_KEY) — skipping');
    return 0;
  }

  // 1. Only poll campaigns that at least one specialist selected
  const campaignIds = await getSubscribedCampaignIds();
  workerLog('info', `Subscribed campaigns: ${campaignIds.length} (${campaignIds.join(', ')})`);
  if (campaignIds.length === 0) return 0;

  // 2. Fetch recent reply emails for subscribed campaigns
  const replyEmails: (Email & { _campaignName?: string })[] = [];

  for (const campaignId of campaignIds) {
    try {
      const res = await instantly.listEmails({
        campaign_id: campaignId,
        limit: EMAILS_PER_CAMPAIGN,
      });
      const allEmails = res.items ?? [];
      const replies = allEmails.filter((e) => (e.ue_type ?? 1) === 2);
      workerLog('info', `Campaign ${campaignId}: ${allEmails.length} emails fetched, ${replies.length} replies (ue_type=2)`);
      for (const r of replies) {
        replyEmails.push(r as Email & { _campaignName?: string });
      }
    } catch (err) {
      workerLog('error', `Failed to fetch emails for campaign ${campaignId}`, err);
    }
  }

  if (replyEmails.length === 0) {
    workerLog('info', 'No reply emails found across subscribed campaigns');
    return 0;
  }

  // 3. Deduplicate: skip emails that already have a qualification record
  const emailIds = replyEmails.map((e) => e.id).filter(Boolean);
  const { data: existing } = await db
    .from('instantly_lead_qualifications')
    .select('instantly_email_id')
    .in('instantly_email_id', emailIds);

  const existingIds = new Set(
    (existing ?? []).map((r: { instantly_email_id: string }) => r.instantly_email_id),
  );
  const newReplies = replyEmails.filter((e) => e.id && !existingIds.has(e.id));

  if (newReplies.length === 0) return 0;

  workerLog('info', `Found ${newReplies.length} new reply(s) across ${campaignIds.length} subscribed campaign(s)`);

  // 4. Qualify each new reply (capped per tick to stay within rate limits)
  let processed = 0;
  for (const reply of newReplies.slice(0, MAX_QUALIFY_PER_TICK)) {
    try {
      await qualifyOneReply(db, reply, apiKey);
      processed++;
    } catch (err) {
      workerLog('error', `Failed to qualify reply ${reply.id}`, err);
      await db.from('instantly_lead_qualifications').insert({
        campaign_id: reply.campaign_id ?? 'unknown',
        lead_email: reply.from_address_email ?? 'unknown',
        thread_id: reply.thread_id,
        instantly_email_id: reply.id,
        status: 'error',
        error_message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return processed;
}

async function qualifyOneReply(
  db: NonNullable<typeof supabaseAdmin>,
  reply: Email & { _campaignName?: string },
  apiKey: string,
): Promise<void> {
  const campaignId = reply.campaign_id;
  const leadEmail =
    reply.from_address_email ??
    reply.to_address_email_list ??
    '';

  if (!campaignId || !leadEmail) return;

  const result = await qualifyReply(campaignId, leadEmail, reply.thread_id, {
    apiKey,
    model: MODEL,
  });

  const campaignName = reply._campaignName ?? null;

  let leadName: string | undefined;
  let companyName: string | undefined;
  try {
    const leads = await instantly.getLeadsByEmail({ email: leadEmail });
    const lead = leads?.[0];
    if (lead) {
      leadName =
        [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined;
      companyName = lead.company_name ?? undefined;
    }
  } catch {
    // lead metadata is optional enrichment
  }

  const replyText = result.threadContext
    ? getBodyText(result.threadContext.replyEmail.body)
    : getBodyText(reply.body);
  const lastOutText = result.threadContext?.lastOutbound
    ? getBodyText(result.threadContext.lastOutbound.body)
    : null;

  let status: string;
  if (result.needsReview) status = 'needs_review';
  else if (result.isLead) status = 'lead';
  else if (result.objectionHandleable) status = 'objection';
  else status = 'not_lead';

  await db.from('instantly_lead_qualifications').insert({
    campaign_id: campaignId,
    campaign_name: campaignName,
    lead_email: leadEmail,
    lead_name: leadName,
    company_name: companyName,
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
    instantly_lead_id: null,
    reply_timestamp: reply.timestamp_email ?? null,
    objection_handleable: result.objectionHandleable,
    objection_draft: result.objectionDraft,
  });

  workerLog(
    'info',
    `Classified ${leadEmail} in campaign ${campaignId}: ${status}${result.objectionHandleable ? ' [objection]' : ''} (confidence: ${result.confidence.toFixed(2)})`,
  );
}
