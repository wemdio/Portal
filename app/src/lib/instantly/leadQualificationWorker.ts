import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import { qualifyReply, getBodyText } from './leadQualifier';
import * as instantly from './client';
import type { Email } from './types';

const EMAILS_PER_CAMPAIGN = 50;
const MAX_QUALIFY_PER_TICK = 20;
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
  const interCampaignDelay = Math.max(
    1000,
    Number(process.env.INSTANTLY_LEADS_INTER_CAMPAIGN_DELAY_MS ?? '3500'),
  );

  for (let i = 0; i < campaignIds.length; i++) {
    const campaignId = campaignIds[i];
    if (i > 0) await new Promise((r) => setTimeout(r, interCampaignDelay));
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

  // 3a. Deduplicate: skip reply emails that were already processed
  // Batch .in() queries to avoid PostgREST URL length limits
  const emailIds = replyEmails.map((e) => e.id).filter(Boolean) as string[];
  const existingIds = new Set<string>();
  const BATCH_SIZE = 50;
  for (let i = 0; i < emailIds.length; i += BATCH_SIZE) {
    const batch = emailIds.slice(i, i + BATCH_SIZE);
    const { data: existing } = await db
      .from('instantly_lead_qualifications')
      .select('instantly_email_id')
      .in('instantly_email_id', batch);
    if (existing) {
      for (const r of existing) {
        existingIds.add((r as { instantly_email_id: string }).instantly_email_id);
      }
    }
  }

  let newReplies = replyEmails.filter((e) => e.id && !existingIds.has(e.id));

  // 3b. Within current batch: keep only the most recent reply per lead+campaign
  const latestByLead = new Map<string, (typeof newReplies)[0]>();
  for (const reply of newReplies) {
    const leadEmail = reply.from_address_email ?? '';
    const key = `${leadEmail}::${reply.campaign_id}`;
    const prev = latestByLead.get(key);
    if (!prev) {
      latestByLead.set(key, reply);
    } else {
      const prevTs = new Date(prev.timestamp_email ?? prev.timestamp_created ?? 0).getTime();
      const curTs = new Date(reply.timestamp_email ?? reply.timestamp_created ?? 0).getTime();
      if (curTs > prevTs) latestByLead.set(key, reply);
    }
  }
  newReplies = [...latestByLead.values()];

  if (newReplies.length === 0) return 0;

  workerLog('info', `Found ${newReplies.length} new reply(s) across ${campaignIds.length} subscribed campaign(s)`);

  // 4. Qualify each new reply (capped per tick to stay within rate limits)
  let processed = 0;
  for (let i = 0; i < Math.min(newReplies.length, MAX_QUALIFY_PER_TICK); i++) {
    const reply = newReplies[i];
    if (i > 0) await new Promise((r) => setTimeout(r, interCampaignDelay));
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
    const leads = await instantly.getLeadsByEmail({ email: leadEmail, campaign_id: campaignId });
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

  const { data: inserted } = await db.from('instantly_lead_qualifications').upsert({
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
  }, { onConflict: 'instantly_email_id', ignoreDuplicates: true }).select('id').single();

  workerLog(
    'info',
    `Classified ${leadEmail} in campaign ${campaignId}: ${status}${result.objectionHandleable ? ' [objection]' : ''} (confidence: ${result.confidence.toFixed(2)})`,
  );

  if (status === 'lead' && inserted?.id && supabaseMain) {
    await notifySpecialistsAboutLead(
      db,
      inserted.id,
      campaignId,
      leadEmail,
      leadName ?? null,
      companyName ?? null,
      campaignName,
    );
  }
}

/**
 * Create in-app notifications for specialists subscribed to the campaign.
 * Also logs the 'specialist' level in deadline_notification_log for dedup/escalation.
 */
async function notifySpecialistsAboutLead(
  instantlyDb: NonNullable<typeof supabaseAdmin>,
  qualificationId: string,
  campaignId: string,
  leadEmail: string,
  leadName: string | null,
  companyName: string | null,
  campaignName: string | null,
): Promise<void> {
  if (!supabaseMain) return;

  try {
    // Find users subscribed to this campaign
    const { data: prefs } = await instantlyDb
      .from('user_instantly_campaign_preferences')
      .select('user_id')
      .eq('campaign_id', campaignId);

    if (!prefs?.length) {
      workerLog('warn', `No users subscribed to campaign ${campaignId} — no lead notification sent`);
      return;
    }

    const userIds = [...new Set(prefs.map((p: { user_id: string }) => p.user_id))];

    const contactLabel = leadName ?? leadEmail;
    const campaignLabel = campaignName ? ` (${campaignName})` : '';

    const rows = userIds.map((uid) => ({
      user_id: uid,
      type: 'lead_new',
      title: 'Новый квалифицированный лид',
      body: `${contactLabel}${companyName ? ` — ${companyName}` : ''}${campaignLabel}`,
      entity_type: 'lead_qualification',
      entity_id: qualificationId,
    }));

    const { error: notifErr } = await supabaseMain
      .from('notifications')
      .insert(rows);

    if (notifErr) {
      workerLog('error', 'Failed to create lead notifications', notifErr.message);
      return;
    }

    // Log for escalation dedup
    await supabaseMain
      .from('deadline_notification_log')
      .upsert(
        {
          entity_type: 'lead_qualification',
          entity_id: qualificationId,
          level: 'specialist',
        },
        { onConflict: 'entity_type,entity_id,level' },
      );

    workerLog('info', `Created lead notifications for ${userIds.length} specialist(s)`);
  } catch (err) {
    workerLog('error', 'Error creating lead notifications', err);
  }
}
