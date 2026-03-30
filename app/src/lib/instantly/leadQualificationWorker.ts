import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { qualifyReply, getBodyText } from './leadQualifier';
import * as instantly from './client';
import type { Email, Campaign } from './types';

const EMAILS_PER_CAMPAIGN = 30;
const MAX_CAMPAIGNS_PER_TICK = 20;
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
 * Main polling function: fetches recent reply emails from the Instantly API,
 * deduplicates against already-processed records, and qualifies new ones via AI.
 * Returns the number of new replies qualified.
 */
export async function pollAndQualifyReplies(): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;

  const apiKey = API_KEY();
  if (!apiKey) return 0;

  // 1. Get active campaigns to poll
  let campaigns: Campaign[];
  try {
    campaigns = await instantly.listAllCampaigns(200);
  } catch (err) {
    workerLog('error', 'Failed to fetch campaigns from Instantly', err);
    return 0;
  }

  const activeCampaigns = campaigns
    .filter((c) => c.status === 1 || c.status === 2)
    .slice(0, MAX_CAMPAIGNS_PER_TICK);

  if (activeCampaigns.length === 0) return 0;

  // 2. Fetch recent reply emails across campaigns
  const replyEmails: (Email & { _campaignName?: string })[] = [];

  for (const campaign of activeCampaigns) {
    try {
      const res = await instantly.listEmails({
        campaign_id: campaign.id,
        limit: EMAILS_PER_CAMPAIGN,
      });
      const replies = (res.items ?? []).filter((e) => (e.ue_type ?? 1) === 2);
      for (const r of replies) {
        (r as Email & { _campaignName?: string })._campaignName = campaign.name;
        replyEmails.push(r as Email & { _campaignName?: string });
      }
    } catch (err) {
      workerLog('warn', `Failed to fetch emails for campaign ${campaign.id}`, err);
    }
  }

  if (replyEmails.length === 0) return 0;

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

  workerLog('info', `Found ${newReplies.length} new reply email(s) to qualify`);

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
  });

  workerLog(
    'info',
    `Classified ${leadEmail} in campaign ${campaignId}: ${status} (confidence: ${result.confidence.toFixed(2)})`,
  );
}
