import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { UnipileClient } from './unipileClient';
import {
  parseMessageTemplate,
  leadToInfo,
  personalizeInviteMessage,
  personalizeFollowUp,
} from './aiService';
import { extractPublicIdentifier } from './leadHelpers';
import {
  applyCooldownToAccount,
  COOLDOWN_MINUTES,
  describeCooldownReason,
  detectAccountCooldownError,
  isAccountInCooldown,
  type AccountCooldownKind,
} from './accountCooldown';
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

/**
 * Thrown when a Unipile call indicated LinkedIn parked our account
 * (invitation limit / already-invited storm / restricted). The current tick
 * is aborted so we don't burn more requests on the same blocked account.
 */
class AccountCooldownTriggered extends Error {
  constructor(public readonly kind: AccountCooldownKind) {
    super(`Account cooldown triggered: ${kind}`);
    this.name = 'AccountCooldownTriggered';
  }
}

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

  // Log helper — writes to DB so the UI logs tab can display entries.
  // IMPORTANT: supabase-js PostgrestBuilder is lazy — it only fires the HTTP
  // request when `.then()` / `await` is called. Using `void builder` does NOT
  // trigger execution, so we must invoke `.then()` (fire-and-forget, but still
  // actually fire). Errors are logged to stderr so they're visible in worker logs.
  // Определён здесь (а не ниже) чтобы ранние return'ы тоже могли логировать —
  // иначе кампания «молча не запускается» и причину никак не увидеть в UI.
  const log: LogFn = (level, message, leadName, stepIndex) => {
    db.from('li_campaign_logs')
      .insert({
        campaign_id: campaignId,
        level,
        message,
        lead_name: leadName ?? null,
        step_index: stepIndex ?? null,
      })
      .then(({ error }) => {
        if (error) {
          console.warn(`[li-outreach] log insert failed for campaign ${campaignId}:`, error.message);
        }
      }, (err) => {
        console.warn(`[li-outreach] log insert threw for campaign ${campaignId}:`, err);
      });
  };

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
    log('error', 'Тик пропущен — не настроены Unipile DSN / API Key. Откройте вкладку «Настройки» и заполните их.');
    return { processed: 0, errors: 0 };
  }

  // Get account (need cooldown_until so we can skip the whole tick when LI
  // told us to back off on a previous run).
  const { data: account } = await db
    .from('li_accounts')
    .select('id, unipile_account_id, cooldown_until, cooldown_reason')
    .eq('id', campaign.account_id ?? '')
    .maybeSingle<{
      id: string;
      unipile_account_id: string;
      cooldown_until: string | null;
      cooldown_reason: AccountCooldownKind | null;
    }>();

  if (account && isAccountInCooldown(account)) {
    const until = new Date(account.cooldown_until!).toLocaleString('ru-RU');
    // Lazily use the campaign log helper here too — but we need it defined
    // first, so insert the message directly.
    db.from('li_campaign_logs')
      .insert({
        campaign_id: campaignId,
        level: 'warning',
        message: `Тик пропущен — аккаунт в отлёжке до ${until} (причина: ${account.cooldown_reason ?? 'unknown'})`,
        lead_name: null,
        step_index: null,
      })
      .then(({ error }) => {
        if (error) console.warn(`[li-outreach] cooldown skip log failed: ${error.message}`);
      }, () => undefined);
    return { processed: 0, errors: 0 };
  }

  const client = new UnipileClient(
    settings.unipile_dsn,
    settings.unipile_api_key,
    account?.unipile_account_id,
  );

  const aiConfig = settings.openai_api_key
    ? { apiKey: settings.openai_api_key, model: settings.openai_model }
    : { apiKey: process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '', model: 'gpt-4o-mini' };

  const steps = (campaign.steps ?? []) as LiCampaignStep[];
  if (steps.length === 0) {
    log('warning', 'Тик пропущен — в кампании нет ни одного шага. Добавьте хотя бы один шаг (инвайт / сообщение / ожидание) и сохраните кампанию.');
    return { processed: 0, errors: 0 };
  }

  if (!campaign.account_id) {
    log('error', 'Тик пропущен — к кампании не привязан LinkedIn-аккаунт. Выберите аккаунт в настройках кампании.');
    return { processed: 0, errors: 0 };
  }
  if (!account) {
    log('error', 'Тик пропущен — привязанный LinkedIn-аккаунт не найден (возможно, устаревшая запись). Откройте вкладку «Аккаунты», синхронизируйте и переназначьте аккаунт кампании.');
    return { processed: 0, errors: 0 };
  }

  log('info', `Тик запущен — кампания «${campaign.name}», аккаунт ${account.unipile_account_id ?? 'N/A'}`);

  // Daily-counter reset is now atomic inside `li_campaign_increment_invite`
  // (see migration 20260420_0002). For the in-memory state used by the
  // limit-check and the "найдено N лидов / отправлено сегодня X" log line,
  // mirror that "fresh day → 0" view here so we don't briefly show last
  // night's count before the first invite of the day.
  const today = todayStr();
  if (campaign.last_invite_date !== today) {
    campaign.invites_sent_today = 0;
    log('info', `Новый день — счётчик инвайтов сброшен (лимит: ${campaign.daily_invite_limit}/день)`);
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

  if (!campaignLeads?.length) {
    log('info', 'Нет лидов для обработки в этом тике');
    return { processed: 0, errors: 0 };
  }

  const pendingCount = campaignLeads.filter((cl) => (cl as { status: string }).status === 'pending').length;
  const waitingCount = campaignLeads.filter((cl) => (cl as { status: string }).status === 'waiting').length;
  const inProgressCount = campaignLeads.filter((cl) => (cl as { status: string }).status === 'in_progress').length;
  log('info', `Найдено ${campaignLeads.length} лидов: ${pendingCount} pending, ${inProgressCount} in_progress, ${waitingCount} waiting | отправлено сегодня: ${campaign.invites_sent_today}/${campaign.daily_invite_limit}`);

  let processed = 0;
  let errors = 0;

  for (const cl of campaignLeads as Array<LiCampaignLead & { lead: LiLead }>) {
    if (!cl.lead) continue;

    if (cl.user_replied && campaign.stop_on_reply) {
      await db
        .from('li_campaign_leads')
        .update({ status: 'completed', updated_at: now })
        .eq('id', cl.id);
      log('info', 'Завершён — получен ответ от пользователя (stop_on_reply)', cl.lead.name);
      continue;
    }

    const stepIdx = cl.current_step;
    if (stepIdx >= steps.length) {
      await db
        .from('li_campaign_leads')
        .update({ status: 'completed', updated_at: now })
        .eq('id', cl.id);
      log('info', 'Все шаги пройдены — лид завершён', cl.lead.name);
      continue;
    }

    const step = steps[stepIdx]!;

    try {
      log('info', `Обработка шага ${stepIdx + 1}/${steps.length} (${step.type})`, cl.lead.name, stepIdx);
      await processStep(step, stepIdx, cl, cl.lead, campaign, client, aiConfig, db, log, account?.id ?? null);
      processed++;
    } catch (e) {
      // Cooldown bubble: account already updated inside processStep — log and
      // abort the rest of the tick so we don't keep banging on a parked acc.
      if (e instanceof AccountCooldownTriggered) {
        const minutes = COOLDOWN_MINUTES[e.kind];
        errors++;
        log(
          'warning',
          `Аккаунт ушёл в отлёжку на ${minutes} мин — ${describeCooldownReason(e.kind)}. Тик прерван, следующая попытка после восстановления.`,
          cl.lead.name,
          stepIdx,
        );
        break;
      }
      const msg = e instanceof Error ? e.message : String(e);
      errors++;
      log('error', `Ошибка на шаге ${stepIdx + 1}/${steps.length} (${step.type}): ${msg}`, cl.lead.name, stepIdx);
      await db
        .from('li_campaign_leads')
        .update({ status: 'error', error_message: msg, updated_at: now })
        .eq('id', cl.id);
    }

    // Random delay between leads
    const delaySec = Math.floor(Math.random() * (campaign.max_delay - campaign.min_delay + 1)) + campaign.min_delay;
    log('info', `Пауза ${delaySec}с перед следующим лидом`);
    await randomDelay(campaign.min_delay, campaign.max_delay);
  }

  log('info', `Тик завершён: обработано ${processed}, ошибок ${errors}, всего в очереди было ${campaignLeads.length}`);
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
  accountDbId: string | null,
): Promise<void> {
  switch (step.type) {
    case 'invite':
      await processInviteStep(step, stepIdx, cl, lead, campaign, client, aiConfig, db, log, accountDbId);
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
  accountDbId: string | null,
): Promise<void> {
  const now = new Date().toISOString();

  // If the lead is already invited/connected/messaged/replied, skip the API
  // call entirely and just advance the campaign step. Before this guard the
  // runner was calling sendInvite for every lead on step 0 regardless of
  // their status — LinkedIn returned `already_invited` 235 times/day, which
  // looks like spam to their abuse detector even though no real invite goes
  // out. See prod Apr 30, 2026: 160 API calls in one day at a limit of 30.
  if (['invited', 'connected', 'messaged', 'replied'].includes(lead.status)) {
    log(
      'info',
      `Лид уже в статусе «${lead.status}» — пропуск инвайта без обращения к API`,
      lead.name,
      stepIdx,
    );
    await db
      .from('li_campaign_leads')
      .update({
        current_step: stepIdx + 1,
        status: stepIdx + 1 < (campaign.steps?.length ?? 0) ? 'in_progress' : 'completed',
        updated_at: now,
      })
      .eq('id', cl.id);
    return;
  }

  if (campaign.invites_sent_today >= campaign.daily_invite_limit) {
    log('warning', `Дневной лимит инвайтов достигнут (${campaign.invites_sent_today}/${campaign.daily_invite_limit}) — пропуск`, lead.name, stepIdx);
    return;
  }

  let providerId = lead.linkedin_id;
  // Fallback: derive public_identifier from profile_url if missing.
  // Imports/scrapers often store profile_url but leave public_identifier null.
  const publicId = lead.public_identifier ?? extractPublicIdentifier(lead.profile_url);
  if (!lead.public_identifier && publicId) {
    await db.from('li_leads').update({ public_identifier: publicId }).eq('id', lead.id);
    log('info', `public_identifier восстановлен из profile_url: ${publicId}`, lead.name, stepIdx);
  }

  if (!providerId && publicId) {
    log('info', `Резолв provider_id по public_identifier: ${publicId}`, lead.name, stepIdx);
    try {
      providerId = await client.getProviderId(publicId);
      await db.from('li_leads').update({ linkedin_id: providerId }).eq('id', lead.id);
      log('info', `provider_id получен: ${providerId}`, lead.name, stepIdx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('error', `Не удалось получить provider_id: ${msg}`, lead.name, stepIdx);
      throw new Error('Cannot resolve provider_id');
    }
  }
  if (!providerId) {
    log('error', 'Нет provider_id и public_identifier — невозможно отправить инвайт', lead.name, stepIdx);
    throw new Error('No provider_id and no public_identifier');
  }

  let message: string | null = step.message ?? null;
  if (message) {
    message = parseMessageTemplate(message, leadToInfo(lead));
    if (campaign.use_ai && aiConfig.apiKey) {
      log('info', 'AI-персонализация инвайта...', lead.name, stepIdx);
      message = await personalizeInviteMessage(message, leadToInfo(lead), aiConfig, campaign.ai_prompt_invite);
    }
  }

  log('info', `Отправка инвайта${message ? ` (сообщение: "${message.slice(0, 50)}…")` : ' (без сообщения)'}`, lead.name, stepIdx);
  try {
    await client.sendInvite(providerId, message);
  } catch (e) {
    const cooldown = detectAccountCooldownError(e);
    if (cooldown) {
      // `already_invited` is a per-lead signal, NOT an account-wide back-off.
      // It just means LinkedIn still has a pending invitation from us to this
      // specific person. Mark the lead as invited, advance the campaign step,
      // and let the tick continue to the next lead. We saw in prod (Apr 2026)
      // that parking the whole account for 15 min on every such hit dropped
      // throughput from 25/day to ~1/15min on lists with historically-invited
      // contacts. See bug log + accountCooldown.ts.
      if (cooldown.kind === 'already_invited') {
        log(
          'warning',
          `LinkedIn вернул «already_invited» — лид помечен invited и пропущен (аккаунт НЕ паркуется, тик продолжается)`,
          lead.name,
          stepIdx,
        );
        await db.from('li_leads').update({ status: 'invited', updated_at: now }).eq('id', lead.id);
        await db
          .from('li_campaign_leads')
          .update({
            current_step: stepIdx + 1,
            status:
              stepIdx + 1 < (campaign.steps?.length ?? 0) ? 'in_progress' : 'completed',
            updated_at: now,
          })
          .eq('id', cl.id);
        return;
      }

      // invitation_limit / account_restricted — these ARE account-wide signals.
      // Park the account so every campaign + scraper using it stops hammering
      // the API for COOLDOWN_MINUTES[kind] minutes; abort the rest of the tick.
      if (accountDbId) {
        const until = await applyCooldownToAccount(db, accountDbId, cooldown.kind);
        const untilHuman = new Date(until).toLocaleString('ru-RU');
        log(
          'warning',
          `LinkedIn вернул сигнал «${cooldown.kind}» — аккаунт уходит в отлёжку до ${untilHuman}`,
          lead.name,
          stepIdx,
        );
        // Lead stays pending on purpose so it gets picked up again once cooldown expires.
        throw new AccountCooldownTriggered(cooldown.kind);
      }
    }
    throw e;
  }

  // Atomic increment in the DB so concurrent ticks (after a worker restart
  // that cleared the in-memory tick debounce) and multiple leads inside one
  // tick can never share a stale read. The RPC also handles new-day reset
  // in the same statement. See migration 20260420_0002.
  const today = todayStr();
  const { data: rpcData, error: rpcErr } = await db.rpc('li_campaign_increment_invite', {
    p_campaign_id: campaign.id,
    p_today: today,
  });
  if (rpcErr || typeof rpcData !== 'number') {
    log(
      'error',
      `Не удалось обновить дневной счётчик инвайтов: ${rpcErr?.message ?? 'нет данных от RPC'}`,
      lead.name,
      stepIdx,
    );
    throw new Error(`li_campaign_increment_invite RPC failed: ${rpcErr?.message ?? 'no data'}`);
  }
  const newCount = rpcData;
  campaign.invites_sent_today = newCount;
  campaign.last_invite_date = today;

  await db.from('li_leads').update({ status: 'invited', updated_at: now }).eq('id', lead.id);

  await db
    .from('li_campaign_leads')
    .update({ current_step: stepIdx + 1, status: stepIdx + 1 < (campaign.steps?.length ?? 0) ? 'in_progress' : 'completed', updated_at: now })
    .eq('id', cl.id);

  log('info', `Инвайт отправлен (${newCount}/${campaign.daily_invite_limit} сегодня)`, lead.name, stepIdx);
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
    const nextActionDate = new Date(cl.next_action_at);
    if (nextActionDate <= now) {
      await db
        .from('li_campaign_leads')
        .update({ current_step: stepIdx + 1, status: 'in_progress', next_action_at: null, updated_at: now.toISOString() })
        .eq('id', cl.id);
      log('info', `Ожидание завершено → переход к шагу ${stepIdx + 2}`, leadName, stepIdx);
    } else {
      const remainMs = nextActionDate.getTime() - now.getTime();
      const remainH = Math.round(remainMs / 3_600_000 * 10) / 10;
      log('info', `Ещё ожидает (осталось ~${remainH}ч, до ${nextActionDate.toLocaleString('ru-RU')})`, leadName, stepIdx);
    }
    return;
  }

  const nextAt = new Date(now.getTime() + (waitMs || 86400_000));
  await db
    .from('li_campaign_leads')
    .update({ status: 'waiting', next_action_at: nextAt.toISOString(), updated_at: now.toISOString() })
    .eq('id', cl.id);

  const label = step.days ? `${step.days}д` : step.hours ? `${step.hours}ч` : `${step.minutes ?? 1}мин`;
  log('info', `Установлено ожидание ${label} (до ${nextAt.toLocaleString('ru-RU')})`, leadName, stepIdx);
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
    // Connection guard. Without it, after a 2-day `wait` step we used to call
    // startChat() blindly and LinkedIn returned `errors/no_connection_with_recipient`
    // for ~1499 leads in a single prod week (Apr 2026). Branch on lead.status:
    //
    //   - 'invited'              → invite sent but accept not yet observed via webhook;
    //                              defer one day so a late accept can still be picked up.
    //   - 'new'                  → we never even sent an invite — something went sideways
    //                              earlier, skip permanently.
    //   - 'connected' / others   → fall through to startChat — chat just wasn't opened yet.
    if (lead.status === 'invited') {
      const deferAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db
        .from('li_campaign_leads')
        .update({ status: 'waiting', next_action_at: deferAt, updated_at: now })
        .eq('id', cl.id);
      log(
        'info',
        `Шаг message пропущен: коннект ещё не подтверждён (lead.status=invited). Повторим ${new Date(deferAt).toLocaleString('ru-RU')}.`,
        lead.name,
        stepIdx,
      );
      return;
    }
    if (lead.status === 'new') {
      await db
        .from('li_campaign_leads')
        .update({
          status: 'skipped',
          error_message: 'No invite recorded (lead.status=new) — message step skipped',
          updated_at: now,
        })
        .eq('id', cl.id);
      log(
        'warning',
        `Шаг message пропущен: для лида не зафиксирован инвайт (lead.status=new) → skipped.`,
        lead.name,
        stepIdx,
      );
      return;
    }

    if (lead.linkedin_id) {
      log('info', 'Нет chat_id — попытка начать чат через Unipile', lead.name, stepIdx);
      try {
        const chatResult = await client.startChat(lead.linkedin_id, step.message ?? undefined);
        const chatId = String(chatResult.id ?? chatResult.chat_id ?? '');
        if (chatId) {
          await db.from('li_leads').update({ chat_id: chatId, status: 'connected', updated_at: now }).eq('id', lead.id);
          lead.chat_id = chatId;
          log('info', `Чат создан (chat_id: ${chatId})`, lead.name, stepIdx);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('warning', `Не удалось начать чат (ещё нет коннекта?): ${msg}`, lead.name, stepIdx);
        return;
      }
    } else {
      log('warning', 'Нет chat_id и linkedin_id — невозможно отправить сообщение, пропуск', lead.name, stepIdx);
      return;
    }
  }

  let message = step.message ?? '';
  message = parseMessageTemplate(message, leadToInfo(lead));
  if (campaign.use_ai && campaign.use_ai_followup && aiConfig.apiKey) {
    const historyEntries = (lead.conversation_history ?? []) as Array<{ role: string; content: string }>;
    log('info', `AI-персонализация follow-up (история: ${historyEntries.length} сообщ.)`, lead.name, stepIdx);
    message = await personalizeFollowUp(message, leadToInfo(lead), historyEntries, aiConfig, campaign.ai_prompt_chat);
  }

  if (!message.trim()) {
    log('warning', 'Пустое сообщение после генерации — пропуск', lead.name, stepIdx);
    return;
  }

  log('info', `Отправка сообщения: "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"`, lead.name, stepIdx);
  await client.sendMessage(lead.chat_id!, message);

  const history = [...(lead.conversation_history ?? []), { role: 'assistant', content: message, ts: now }];
  await db.from('li_leads').update({ conversation_history: history, status: 'messaged', last_activity: now, updated_at: now }).eq('id', lead.id);

  const totalSteps = (campaign.steps?.length ?? 0);
  const isLast = stepIdx + 1 >= totalSteps;
  await db
    .from('li_campaign_leads')
    .update({ current_step: stepIdx + 1, status: isLast ? 'completed' : 'in_progress', updated_at: now })
    .eq('id', cl.id);

  log('info', `Сообщение отправлено${isLast ? ' (последний шаг — лид завершён)' : ''}`, lead.name, stepIdx);
}
