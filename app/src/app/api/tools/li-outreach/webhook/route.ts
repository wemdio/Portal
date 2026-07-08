import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { safeEqual } from '@/lib/crypto/safeEqual';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';
import { generateAutoReply, leadToInfo, parseMessageTemplate } from '@/lib/liOutreach/aiService';
import type { LiLead, LiCampaign } from '@/lib/liOutreach/types';

export const dynamic = 'force-dynamic';

/**
 * Unipile webhook receiver.
 *
 * Auth: optional shared secret in the URL query (`?secret=…`), ENFORCED ONLY when
 * LI_OUTREACH_WEBHOOK_SECRET is set in env. To activate: set that env var and
 * register the Unipile webhook URL with `?secret=<that value>`. Until then the
 * endpoint stays open (legacy behaviour) so the live integration doesn't break.
 * (Previously a comment claimed a secret check that did not actually exist.)
 */
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const webhookSecret = (process.env.LI_OUTREACH_WEBHOOK_SECRET ?? '').trim();
  if (webhookSecret && !safeEqual(req.nextUrl.searchParams.get('secret') ?? '', webhookSecret)) {
    // Forged / missing secret → drop quietly with 200 (Unipile retries on non-2xx).
    return NextResponse.json({ ok: true });
  }

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

  // Eager stop_on_reply: complete this lead's campaign-leads in stop_on_reply
  // campaigns NOW, on reply — instead of letting the runner lazily complete them
  // only when their wait-timer next expires (up to the full wait window later).
  // Mirrors the runner's stop_on_reply guard. The scheduled follow-up never goes
  // out either way (the runner completes before the message step), but eager
  // completion keeps state honest: the lead shows 'completed' immediately and the
  // health digest stops flagging "ответили, но не остановлены". The AI auto-reply
  // below still fires — it's a direct response to the reply, not a scheduled step.
  const { data: leadCls } = await db
    .from('li_campaign_leads')
    .select('id, campaign_id, status')
    .eq('lead_id', lead.id);
  const campaignIds = [...new Set((leadCls ?? []).map((r) => (r as { campaign_id: string }).campaign_id))];
  if (campaignIds.length > 0) {
    const { data: stopCamps } = await db
      .from('li_campaigns')
      .select('id')
      .eq('stop_on_reply', true)
      .in('id', campaignIds);
    const stopSet = new Set((stopCamps ?? []).map((r) => (r as { id: string }).id));
    const completedAt = new Date().toISOString();
    for (const cl of (leadCls ?? []) as Array<{ id: string; campaign_id: string; status: string }>) {
      if (stopSet.has(cl.campaign_id) && cl.status !== 'completed') {
        await db.from('li_campaign_leads').update({ status: 'completed', updated_at: completedAt }).eq('id', cl.id);
      }
    }
  }

  // Update lead status
  const history = [...(lead.conversation_history ?? []), { role: 'user', content: text, ts: new Date().toISOString() }];
  await db.from('li_leads').update({
    status: 'replied',
    conversation_history: history,
    last_activity: new Date().toISOString(),
  }).eq('id', lead.id);

  // Auto-reply if AI is configured. Both AI creds AND Unipile creds now come
  // from central env — BYOK in li_settings is fully deprecated (see migrations
  // 20260525_0003 for AI and 20260708_0001 for Unipile).
  const aiApiKey = process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '';
  const unipileDsn = process.env.UNIPILE_DSN ?? '';
  const unipileApiKey = process.env.UNIPILE_API_KEY ?? '';
  if (!aiApiKey || !unipileDsn || !unipileApiKey) return;

  // Find active campaign for this lead
  const { data: campaignLeads } = await db
    .from('li_campaign_leads')
    .select('campaign_id')
    .eq('lead_id', lead.id)
    .limit(1);
  const campaignId = (campaignLeads?.[0] as { campaign_id?: string })?.campaign_id;

  if (campaignId) {
    const { data: campaign } = await db.from('li_campaigns').select('*').eq('id', campaignId).maybeSingle<LiCampaign>();
    // `stop_on_reply` means hand the conversation to a human after any real reply.
    if (campaign?.stop_on_reply) return;
    if (campaign?.use_ai && campaign.ai_prompt_chat) {
      const reply = await generateAutoReply(
        text,
        history as Array<{ role: string; content: string }>,
        { apiKey: aiApiKey, model: campaign.ai_model || 'openai/gpt-4o-mini' },
        campaign.ai_prompt_chat,
        leadToInfo(lead),
      );
      if (reply) {
        const client = new UnipileClient(unipileDsn, unipileApiKey, accountId || undefined);
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

  // Unipile creds from shared env (see migration 20260708_0001).
  const unipileDsn = process.env.UNIPILE_DSN ?? '';
  const unipileApiKey = process.env.UNIPILE_API_KEY ?? '';
  if (!unipileDsn || !unipileApiKey) return;

  // Render template variables ({{first_name}}, {{company}}, …) before sending.
  // Without this, leads got literal "Hi {{first_name}}!" in their LinkedIn chat.
  const welcomeText = parseMessageTemplate(campaign.welcome_message, leadToInfo(lead));
  if (!welcomeText.trim()) {
    console.warn('[li-outreach] welcome_message resolved to empty string after template substitution — skipping');
    return;
  }

  const client = new UnipileClient(unipileDsn, unipileApiKey, accountId || undefined);
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
