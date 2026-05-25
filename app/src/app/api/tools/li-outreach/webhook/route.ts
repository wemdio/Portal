import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';
import { generateAutoReply, leadToInfo, parseMessageTemplate } from '@/lib/liOutreach/aiService';
import type { LiLead, LiSettings, LiCampaign } from '@/lib/liOutreach/types';

export const dynamic = 'force-dynamic';

/**
 * Unipile webhook receiver.
 * No Bearer auth — uses webhook_secret for validation.
 */
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = String(payload.event ?? payload.type ?? payload.event_type ?? 'unknown');

  // Audit log. We capture the inserted id so the handler block below can flip
  // `processed=true` (or write `error_message`) once it knows whether the work
  // actually completed. Without this, every row stays `processed=false` and we
  // can't tell a "handler skipped" from a "handler crashed mid-flight" — which
  // is how the welcome-not-sent regression slipped past for weeks.
  const { data: logRow } = await supabaseAdmin
    .from('li_webhook_logs')
    .insert({ event_type: eventType, payload })
    .select('id')
    .single();
  const webhookLogId = (logRow as { id?: number } | null)?.id ?? null;

  const messageEvents = ['message_received', 'messaging.message.received', 'message.received'];
  const connectionEvents = ['connection.accepted', 'invitation.accepted', 'new_relation', 'relation_added'];

  try {
    if (messageEvents.includes(eventType)) {
      await handleMessageReceived(payload);
    }
    if (connectionEvents.includes(eventType)) {
      await handleConnectionAccepted(payload);
    }
    if (webhookLogId != null) {
      await supabaseAdmin
        .from('li_webhook_logs')
        .update({ processed: true })
        .eq('id', webhookLogId);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[li-outreach] webhook ${eventType} handler crashed:`, msg);
    if (webhookLogId != null) {
      // Best-effort: persist the failure reason so we can audit it later. We
      // still respond 200 below — Unipile retries on non-2xx, and our handlers
      // aren't idempotent (would double-send messages, increment counters, ...).
      await supabaseAdmin
        .from('li_webhook_logs')
        .update({ error_message: msg })
        .eq('id', webhookLogId);
    }
  }

  return NextResponse.json({ ok: true });
}

async function handleMessageReceived(payload: Record<string, unknown>): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const data = (payload.data ?? payload) as Record<string, unknown>;
  const chatId = String(data.chat_id ?? '');
  const text = String(data.text ?? data.message ?? '');
  const _senderId = String(
    (data.sender as Record<string, unknown>)?.attendee_provider_id ?? data.sender_id ?? '',
  );
  const accountId = String(data.account_id ?? '');

  // Unipile fires `message_received` for BOTH directions — incoming AND outgoing.
  // Without this guard, every message we send via the campaign runner (or
  // every message the operator sends manually from LinkedIn web) would mark
  // the recipient as `user_replied=true` and trigger `stop_on_reply` →
  // campaigns silently die. See bug log Apr 2026 + li_webhook_logs sample.
  if (data.is_sender === true || data.is_sender === 'true') return;

  if (!chatId || !text) return;

  // Find lead by chat_id
  const { data: lead } = await db
    .from('li_leads')
    .select('*')
    .eq('chat_id', chatId)
    .maybeSingle<LiLead>();
  if (!lead) return;

  // Mark as replied in campaign_leads
  await db
    .from('li_campaign_leads')
    .update({ user_replied: true, updated_at: new Date().toISOString() })
    .eq('lead_id', lead.id);

  // Update lead status
  const history = [...(lead.conversation_history ?? []), { role: 'user', content: text, ts: new Date().toISOString() }];
  await db.from('li_leads').update({
    status: 'replied',
    conversation_history: history,
    last_activity: new Date().toISOString(),
  }).eq('id', lead.id);

  // Auto-reply if AI is configured. AI credentials now come from the central
  // env Requesty router (BYOK in li_settings is deprecated — see migration
  // 20260525_0003_li_outreach_drop_byok_keys.sql); we only still need the
  // li_settings row for the Unipile DSN/api_key, since those *are* per-user.
  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', lead.user_id)
    .maybeSingle<LiSettings>();
  const aiApiKey = process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '';
  if (!aiApiKey || !settings?.unipile_dsn) return;

  // Find active campaign for this lead
  const { data: campaignLeads } = await db
    .from('li_campaign_leads')
    .select('campaign_id')
    .eq('lead_id', lead.id)
    .limit(1);
  const campaignId = (campaignLeads?.[0] as { campaign_id?: string })?.campaign_id;

  if (campaignId) {
    const { data: campaign } = await db.from('li_campaigns').select('*').eq('id', campaignId).maybeSingle<LiCampaign>();
    if (campaign?.use_ai && campaign.ai_prompt_chat) {
      const reply = await generateAutoReply(
        text,
        history as Array<{ role: string; content: string }>,
        { apiKey: aiApiKey, model: campaign.ai_model || 'openai/gpt-4o-mini' },
        campaign.ai_prompt_chat,
        leadToInfo(lead),
      );
      if (reply) {
        const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key, accountId || undefined);
        try {
          await client.sendMessage(chatId, reply);
          const updatedHistory = [...history, { role: 'assistant', content: reply, ts: new Date().toISOString() }];
          await db.from('li_leads').update({ conversation_history: updatedHistory }).eq('id', lead.id);
        } catch (e) {
          console.error('[li-outreach] webhook auto-reply failed:', e instanceof Error ? e.message : e);
        }
      }
    }
  }
}

async function handleConnectionAccepted(payload: Record<string, unknown>): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const data = (payload.data ?? payload) as Record<string, unknown>;
  const providerId = String(data.user_provider_id ?? data.provider_id ?? '');
  const payloadChatId = String(data.chat_id ?? '');
  const accountId = String(data.account_id ?? '');

  if (!providerId) return;

  // Find lead by linkedin_id
  const { data: lead } = await db
    .from('li_leads')
    .select('*')
    .eq('linkedin_id', providerId)
    .maybeSingle<LiLead>();
  if (!lead) return;

  // Update lead. Don't overwrite chat_id with empty — Unipile's `new_relation`
  // payload doesn't carry one (the chat doesn't exist yet), so we only update
  // chat_id when the webhook actually provides one (e.g. invitation.accepted
  // variants that do carry it).
  await db.from('li_leads').update({
    status: 'connected',
    chat_id: payloadChatId || lead.chat_id,
    updated_at: new Date().toISOString(),
  }).eq('id', lead.id);

  // Mark invite_accepted in campaign_leads
  await db
    .from('li_campaign_leads')
    .update({ invite_accepted: true, updated_at: new Date().toISOString() })
    .eq('lead_id', lead.id);

  // Send welcome message if configured
  const { data: campaignLeads } = await db
    .from('li_campaign_leads')
    .select('id, campaign_id')
    .eq('lead_id', lead.id)
    .limit(1);
  const campaignLeadRow = campaignLeads?.[0] as { id?: string; campaign_id?: string } | undefined;
  const campaignId = campaignLeadRow?.campaign_id;
  const campaignLeadId = campaignLeadRow?.id;
  // Previously we also required `chatId` here, which silently dropped EVERY
  // `new_relation` event — Unipile doesn't include chat_id in that payload
  // because the chat doesn't exist yet (LinkedIn opens it with the first
  // message). Result: 81 leads in 14 days accepted the invite, never got the
  // welcome, then 2 days later got a duplicated follow-up from the runner's
  // startChat fallback. Now we create the chat ourselves below when missing.
  if (!campaignId) return;

  const { data: campaign } = await db.from('li_campaigns').select('*').eq('id', campaignId).maybeSingle<LiCampaign>();
  if (!campaign?.welcome_message) return;

  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', lead.user_id)
    .maybeSingle<LiSettings>();
  if (!settings?.unipile_dsn) return;

  // Render template variables ({{first_name}}, {{company}}, …) before sending.
  // Without this, leads got literal "Hi {{first_name}}!" in their LinkedIn chat.
  const welcomeText = parseMessageTemplate(campaign.welcome_message, leadToInfo(lead));
  if (!welcomeText.trim()) {
    console.warn('[li-outreach] welcome_message resolved to empty string after template substitution — skipping');
    return;
  }

  const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key, accountId || undefined);
  try {
    let effectiveChatId = payloadChatId;
    if (!effectiveChatId) {
      // No chat yet — open one with the welcome as the first message. Unipile
      // returns the new chat object; pull its id and persist so the campaign
      // runner can reuse it for the follow-up step (without this it would
      // call startChat itself two days later and re-open another chat).
      const chatResult = await client.startChat(providerId, welcomeText);
      effectiveChatId = String(
        (chatResult as { id?: string; chat_id?: string }).id ??
          (chatResult as { id?: string; chat_id?: string }).chat_id ??
          '',
      );
      if (!effectiveChatId) {
        console.warn('[li-outreach] startChat returned no chat_id; welcome considered undelivered');
        return;
      }
      await db
        .from('li_leads')
        .update({ chat_id: effectiveChatId, updated_at: new Date().toISOString() })
        .eq('id', lead.id);
    } else {
      // Chat already existed (re-accept or alternate webhook payload) — fall
      // back to the original path so we don't try to start an already-open chat.
      await client.sendMessage(effectiveChatId, welcomeText);
    }
    // Record successful delivery so the campaign runner's next message step
    // knows the welcome has already been sent and can be skipped — otherwise
    // the lead gets the welcome plus a near-identical scheduled follow-up
    // back-to-back when the wait step expires.
    if (campaignLeadId) {
      await db
        .from('li_campaign_leads')
        .update({ welcome_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', campaignLeadId);
    }
  } catch (e) {
    console.error('[li-outreach] webhook welcome message failed:', e instanceof Error ? e.message : e);
  }
}
