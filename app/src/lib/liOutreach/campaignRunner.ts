import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { UnipileClient } from './unipileClient';
import {
  parseMessageTemplate,
  leadToInfo,
  personalizeInviteMessage,
  personalizeFollowUp,
} from './aiService';
import type {
  LiCampaign,
  LiCampaignLead,
  LiCampaignStep,
  LiLead,
  LiSettings,
} from './types';

/**
 * Campaign Runner — processes one "tick" of a campaign.
 * Called periodically (every ~5 min) by the worker.
 *
 * Port of Python linkedin-ai-responder/app/services/campaign_manager.py → TypeScript.
 */

type LogFn = (level: 'info' | 'warning' | 'error', msg: string, leadName?: string, stepIndex?: number) => void;

function randomDelay(minSec: number, maxSec: number): Promise<void> {
  const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- Campaign tick entry point ------------------------------------------

export async function runCampaignTick(
  campaignId: string,
  userId: string,
): Promise<{ processed: number; errors: number }> {
  if (!supabaseAdmin) return { processed: 0, errors: 0 };
  const db = supabaseAdmin;

  // Load campaign
  const { data: campaign } = await db
    .from('li_campaigns')
    .select('*')
    .eq('id', campaignId)
    .single<LiCampaign>();
  if (!campaign || campaign.status !== 'running') return { processed: 0, errors: 0 };

  // Load settings (for Unipile + OpenAI credentials)
  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<LiSettings>();
  if (!settings?.unipile_dsn || !settings?.unipile_api_key) {
    console.warn(`[li-outreach] campaign ${campaignId}: no Unipile settings, skipping`);
    return { processed: 0, errors: 0 };
  }

  // Get account
  const { data: account } = await db
    .from('li_accounts')
    .select('unipile_account_id')
    .eq('id', campaign.account_id ?? '')
    .maybeSingle<{ unipile_account_id: string }>();

  const client = new UnipileClient(
    settings.unipile_dsn,
    settings.unipile_api_key,
    account?.unipile_account_id,
  );

  const aiConfig = settings.openai_api_key
    ? { apiKey: settings.openai_api_key, model: settings.openai_model }
    : { apiKey: process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '', model: 'gpt-4o-mini' };

  const steps = (campaign.steps ?? []) as LiCampaignStep[];
  if (steps.length === 0) return { processed: 0, errors: 0 };

  // Log helper
  const log: LogFn = (level, message, leadName, stepIndex) => {
    void db.from('li_campaign_logs').insert({
      campaign_id: campaignId,
      level,
      message,
      lead_name: leadName ?? null,
      step_index: stepIndex ?? null,
    });
  };

  // Reset daily invite counter if new day
  const today = todayStr();
  if (campaign.last_invite_date !== today) {
    await db
      .from('li_campaigns')
      .update({ invites_sent_today: 0, last_invite_date: today })
      .eq('id', campaignId);
    campaign.invites_sent_today = 0;
  }

  // Get campaign leads ready to process
  const now = new Date().toISOString();
  const { data: campaignLeads } = await db
    .from('li_campaign_leads')
    .select('*, lead:li_leads(*)')
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'in_progress', 'waiting'])
    .or(`next_action_at.is.null,next_action_at.lte.${now}`)
    .order('created_at', { ascending: true })
    .limit(20);

  if (!campaignLeads?.length) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;

  for (const cl of campaignLeads as Array<LiCampaignLead & { lead: LiLead }>) {
    if (!cl.lead) continue;

    // Skip if user replied and stop_on_reply is enabled
    if (cl.user_replied && campaign.stop_on_reply) {
      await db
        .from('li_campaign_leads')
        .update({ status: 'completed', updated_at: now })
        .eq('id', cl.id);
      log('info', 'Пропущен — пользователь ответил (stop_on_reply)', cl.lead.name);
      continue;
    }

    const stepIdx = cl.current_step;
    if (stepIdx >= steps.length) {
      await db
        .from('li_campaign_leads')
        .update({ status: 'completed', updated_at: now })
        .eq('id', cl.id);
      continue;
    }

    const step = steps[stepIdx]!;

    try {
      await processStep(step, stepIdx, cl, cl.lead, campaign, client, aiConfig, db, log);
      processed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors++;
      log('error', `Ошибка на шаге ${stepIdx}: ${msg}`, cl.lead.name, stepIdx);
      await db
        .from('li_campaign_leads')
        .update({ status: 'error', error_message: msg, updated_at: now })
        .eq('id', cl.id);
    }

    // Random delay between leads
    await randomDelay(campaign.min_delay, campaign.max_delay);
  }

  log('info', `Тик завершён: обработано ${processed}, ошибок ${errors}`);
  return { processed, errors };
}

// ---- Step processors ----------------------------------------------------

async function processStep(
  step: LiCampaignStep,
  stepIdx: number,
  cl: LiCampaignLead,
  lead: LiLead,
  campaign: LiCampaign,
  client: UnipileClient,
  aiConfig: { apiKey: string; model?: string },
  db: NonNullable<typeof supabaseAdmin>,
  log: LogFn,
): Promise<void> {
  switch (step.type) {
    case 'invite':
      await processInviteStep(step, stepIdx, cl, lead, campaign, client, aiConfig, db, log);
      break;

    case 'wait':
      await processWaitStep(step, stepIdx, cl, db, log, lead.name);
      break;

    case 'message':
    case 'follow_up':
      await processMessageStep(step, stepIdx, cl, lead, campaign, client, aiConfig, db, log);
      break;
  }
}

async function processInviteStep(
  step: LiCampaignStep,
  stepIdx: number,
  cl: LiCampaignLead,
  lead: LiLead,
  campaign: LiCampaign,
  client: UnipileClient,
  aiConfig: { apiKey: string; model?: string },
  db: NonNullable<typeof supabaseAdmin>,
  log: LogFn,
): Promise<void> {
  const now = new Date().toISOString();

  // Check daily invite limit
  if (campaign.invites_sent_today >= campaign.daily_invite_limit) {
    log('warning', `Дневной лимит инвайтов (${campaign.daily_invite_limit}) достигнут`, lead.name, stepIdx);
    return;
  }

  // Resolve provider_id if needed
  let providerId = lead.linkedin_id;
  if (!providerId && lead.public_identifier) {
    try {
      providerId = await client.getProviderId(lead.public_identifier);
      await db.from('li_leads').update({ linkedin_id: providerId }).eq('id', lead.id);
    } catch {
      log('error', 'Не удалось получить provider_id', lead.name, stepIdx);
      throw new Error('Cannot resolve provider_id');
    }
  }
  if (!providerId) throw new Error('No provider_id and no public_identifier');

  // Prepare message
  let message: string | null = step.message ?? null;
  if (message) {
    message = parseMessageTemplate(message, leadToInfo(lead));
    if (campaign.use_ai && aiConfig.apiKey) {
      message = await personalizeInviteMessage(message, leadToInfo(lead), aiConfig, campaign.ai_prompt_invite);
    }
  }

  // Send invite
  await client.sendInvite(providerId, message);

  // Update counters
  await db.from('li_campaigns').update({ invites_sent_today: campaign.invites_sent_today + 1 }).eq('id', campaign.id);
  await db.from('li_leads').update({ status: 'invited', updated_at: now }).eq('id', lead.id);

  // Advance to next step
  await db
    .from('li_campaign_leads')
    .update({ current_step: stepIdx + 1, status: stepIdx + 1 < (campaign.steps?.length ?? 0) ? 'in_progress' : 'completed', updated_at: now })
    .eq('id', cl.id);

  log('info', `Инвайт отправлен${message ? ' (с сообщением)' : ''}`, lead.name, stepIdx);
}

async function processWaitStep(
  step: LiCampaignStep,
  stepIdx: number,
  cl: LiCampaignLead,
  db: NonNullable<typeof supabaseAdmin>,
  log: LogFn,
  leadName: string,
): Promise<void> {
  const now = new Date();
  const waitMs =
    (step.days ?? 0) * 86400_000 +
    (step.hours ?? 0) * 3600_000 +
    (step.minutes ?? 0) * 60_000;

  if (cl.status === 'waiting' && cl.next_action_at) {
    // Already waiting — check if time has passed
    if (new Date(cl.next_action_at) <= now) {
      // Wait complete → advance
      await db
        .from('li_campaign_leads')
        .update({ current_step: stepIdx + 1, status: 'in_progress', next_action_at: null, updated_at: now.toISOString() })
        .eq('id', cl.id);
      log('info', `Ожидание завершено, переход к следующему шагу`, leadName, stepIdx);
    }
    return;
  }

  // Start waiting
  const nextAt = new Date(now.getTime() + (waitMs || 86400_000));
  await db
    .from('li_campaign_leads')
    .update({ status: 'waiting', next_action_at: nextAt.toISOString(), updated_at: now.toISOString() })
    .eq('id', cl.id);

  const label = step.days ? `${step.days}д` : step.hours ? `${step.hours}ч` : `${step.minutes ?? 1}мин`;
  log('info', `Ожидание ${label}`, leadName, stepIdx);
}

async function processMessageStep(
  step: LiCampaignStep,
  stepIdx: number,
  cl: LiCampaignLead,
  lead: LiLead,
  campaign: LiCampaign,
  client: UnipileClient,
  aiConfig: { apiKey: string; model?: string },
  db: NonNullable<typeof supabaseAdmin>,
  log: LogFn,
): Promise<void> {
  const now = new Date().toISOString();

  if (!lead.chat_id) {
    // Not connected yet — try to start a chat if we have provider_id
    if (lead.linkedin_id) {
      try {
        const chatResult = await client.startChat(lead.linkedin_id, step.message ?? undefined);
        const chatId = String(chatResult.id ?? chatResult.chat_id ?? '');
        if (chatId) {
          await db.from('li_leads').update({ chat_id: chatId, status: 'connected', updated_at: now }).eq('id', lead.id);
          lead.chat_id = chatId;
        }
      } catch {
        log('warning', 'Не удалось начать чат — возможно, ещё нет коннекта', lead.name, stepIdx);
        return;
      }
    } else {
      log('warning', 'Нет chat_id и linkedin_id — пропускаю', lead.name, stepIdx);
      return;
    }
  }

  // Build message
  let message = step.message ?? '';
  message = parseMessageTemplate(message, leadToInfo(lead));
  if (campaign.use_ai && campaign.use_ai_followup && aiConfig.apiKey) {
    const history = (lead.conversation_history ?? []) as Array<{ role: string; content: string }>;
    message = await personalizeFollowUp(message, leadToInfo(lead), history, aiConfig, campaign.ai_prompt_chat);
  }

  if (!message.trim()) {
    log('warning', 'Пустое сообщение — пропускаю', lead.name, stepIdx);
    return;
  }

  // Send
  await client.sendMessage(lead.chat_id!, message);

  // Update conversation history
  const history = [...(lead.conversation_history ?? []), { role: 'assistant', content: message, ts: now }];
  await db.from('li_leads').update({ conversation_history: history, status: 'messaged', last_activity: now, updated_at: now }).eq('id', lead.id);

  // Advance step
  const totalSteps = (campaign.steps?.length ?? 0);
  await db
    .from('li_campaign_leads')
    .update({ current_step: stepIdx + 1, status: stepIdx + 1 < totalSteps ? 'in_progress' : 'completed', updated_at: now })
    .eq('id', cl.id);

  log('info', `Сообщение отправлено: "${message.slice(0, 60)}…"`, lead.name, stepIdx);
}
