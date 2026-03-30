import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { qualifyReply, getBodyText } from './leadQualifier';
import * as instantly from './client';

const BATCH_SIZE = Number(process.env.INSTANTLY_LEAD_QUAL_BATCH_SIZE ?? '10');
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

type WebhookEvent = {
  id: string;
  event_type: string;
  campaign_id: string | null;
  lead_email: string | null;
  thread_id: string | null;
  email_id: string | null;
  payload: Record<string, unknown>;
};

/**
 * Process unprocessed webhook events: fetch thread context, classify, store result.
 * Returns number of events processed.
 */
export async function processLeadQualificationBatch(): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;

  const apiKey = API_KEY();
  if (!apiKey) {
    workerLog('warn', 'No API key configured for lead qualification');
    return 0;
  }

  const { data: events, error } = await db
    .from('instantly_webhook_events')
    .select('id, event_type, campaign_id, lead_email, thread_id, email_id, payload')
    .eq('processed', false)
    .in('event_type', ['reply_received', 'reply', 'email_reply'])
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    workerLog('error', 'Failed to fetch webhook events', error);
    return 0;
  }

  const batch = (events as WebhookEvent[] | null) ?? [];
  if (batch.length === 0) return 0;

  workerLog('info', `Processing ${batch.length} reply event(s)`);

  let processed = 0;

  for (const evt of batch) {
    try {
      await processOneEvent(db, evt, apiKey);
      processed++;
    } catch (err) {
      workerLog('error', `Failed to process event ${evt.id}`, err);
      await db
        .from('instantly_webhook_events')
        .update({ processed: true })
        .eq('id', evt.id);

      await db.from('instantly_lead_qualifications').insert({
        webhook_event_id: evt.id,
        campaign_id: evt.campaign_id ?? 'unknown',
        lead_email: evt.lead_email ?? 'unknown',
        thread_id: evt.thread_id,
        status: 'error',
        error_message:
          err instanceof Error ? err.message : 'Unknown processing error',
      });
    }
  }

  return processed;
}

async function processOneEvent(
  db: NonNullable<typeof supabaseAdmin>,
  evt: WebhookEvent,
  apiKey: string,
): Promise<void> {
  const campaignId = evt.campaign_id;
  const leadEmail = evt.lead_email;

  if (!campaignId || !leadEmail) {
    await db
      .from('instantly_webhook_events')
      .update({ processed: true })
      .eq('id', evt.id);
    return;
  }

  const existingCheck = await db
    .from('instantly_lead_qualifications')
    .select('id')
    .eq('webhook_event_id', evt.id)
    .maybeSingle();

  if (existingCheck.data) {
    await db
      .from('instantly_webhook_events')
      .update({ processed: true })
      .eq('id', evt.id);
    return;
  }

  const result = await qualifyReply(campaignId, leadEmail, evt.thread_id, {
    apiKey,
    model: MODEL,
  });

  let campaignName: string | undefined;
  try {
    const campaign = await instantly.getCampaign(campaignId);
    campaignName = campaign.name;
  } catch {
    // campaign name is optional
  }

  let leadName: string | undefined;
  let companyName: string | undefined;
  try {
    const leads = await instantly.getLeadsByEmail({ email: leadEmail });
    const lead = leads?.[0];
    if (lead) {
      leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined;
      companyName = lead.company_name ?? undefined;
    }
  } catch {
    // lead metadata is optional
  }

  const replyText = result.threadContext
    ? getBodyText(result.threadContext.replyEmail.body)
    : '';
  const lastOutText = result.threadContext?.lastOutbound
    ? getBodyText(result.threadContext.lastOutbound.body)
    : null;

  let status: string;
  if (result.needsReview) status = 'needs_review';
  else if (result.isLead) status = 'lead';
  else status = 'not_lead';

  await db.from('instantly_lead_qualifications').insert({
    webhook_event_id: evt.id,
    campaign_id: campaignId,
    campaign_name: campaignName,
    lead_email: leadEmail,
    lead_name: leadName,
    company_name: companyName,
    thread_id: evt.thread_id,
    reply_subject: result.threadContext?.replyEmail.subject ?? null,
    reply_preview: replyText.slice(0, 300) || null,
    reply_body: replyText || null,
    last_outbound_preview: lastOutText?.slice(0, 300) ?? null,
    last_outbound_ue_type: result.threadContext?.lastOutbound?.ue_type ?? null,
    status,
    proposal_seen: result.proposalSeen,
    interest_signals: result.interestSignals,
    ai_reason: result.reason,
    ai_confidence: result.confidence,
    instantly_email_id: result.threadContext?.replyEmail.id ?? evt.email_id,
    instantly_lead_id: null,
    reply_timestamp: result.threadContext?.replyEmail.timestamp_email ?? null,
  });

  await db
    .from('instantly_webhook_events')
    .update({ processed: true })
    .eq('id', evt.id);

  workerLog(
    'info',
    `Classified ${leadEmail} in campaign ${campaignId}: ${status} (confidence: ${result.confidence.toFixed(2)})`,
  );
}
