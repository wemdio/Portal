import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';
import { generateAutoReply, leadToInfo } from '@/lib/liOutreach/aiService';
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

  // Log webhook
  await supabaseAdmin.from('li_webhook_logs').insert({
    event_type: eventType,
    payload,
  });

  // Handle message received
  const messageEvents = ['message_received', 'messaging.message.received', 'message.received'];
  if (messageEvents.includes(eventType)) {
    await handleMessageReceived(payload);
  }

  // Handle connection accepted
  const connectionEvents = ['connection.accepted', 'invitation.accepted', 'new_relation', 'relation_added'];
  if (connectionEvents.includes(eventType)) {
    await handleConnectionAccepted(payload);
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

  // Auto-reply if AI is configured
  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', lead.user_id)
    .maybeSingle<LiSettings>();
  if (!settings?.openai_api_key || !settings?.unipile_dsn) return;

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
        { apiKey: settings.openai_api_key, model: settings.openai_model },
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
  const chatId = String(data.chat_id ?? '');
  const accountId = String(data.account_id ?? '');

  if (!providerId) return;

  // Find lead by linkedin_id
  const { data: lead } = await db
    .from('li_leads')
    .select('*')
    .eq('linkedin_id', providerId)
    .maybeSingle<LiLead>();
  if (!lead) return;

  // Update lead
  await db.from('li_leads').update({
    status: 'connected',
    chat_id: chatId || lead.chat_id,
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
    .select('campaign_id')
    .eq('lead_id', lead.id)
    .limit(1);
  const campaignId = (campaignLeads?.[0] as { campaign_id?: string })?.campaign_id;
  if (!campaignId || !chatId) return;

  const { data: campaign } = await db.from('li_campaigns').select('*').eq('id', campaignId).maybeSingle<LiCampaign>();
  if (!campaign?.welcome_message) return;

  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', lead.user_id)
    .maybeSingle<LiSettings>();
  if (!settings?.unipile_dsn) return;

  const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key, accountId || undefined);
  try {
    await client.sendMessage(chatId, campaign.welcome_message);
  } catch (e) {
    console.error('[li-outreach] webhook welcome message failed:', e instanceof Error ? e.message : e);
  }
}
