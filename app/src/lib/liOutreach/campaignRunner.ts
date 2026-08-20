import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { UnipileClient } from './unipileClient';
import {
  parseMessageTemplate,
  leadToInfo,
  personalizeInviteMessage,
  personalizeFollowUp,
} from './aiService';
import { findAiOutputProblems } from './aiOutputGuard';
import { isRepeatOfOurs, type RepeatCheckMessage } from '../outreachRepeatGuard';
import { extractPublicIdentifier } from './leadHelpers';
import { findUnknownPlaceholders, supportedVarsHint } from './messageVars';
import { isInWorkingHours } from './schedule';
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
} from './types';

/**
 * Campaign Runner — processes one "tick" of a campaign.
 * Called periodically (every ~5 min) by the worker.
 *
 * Port of Python linkedin-ai-responder/app/services/campaign_manager.py → TypeScript.
 */

type LogFn = (level: 'info' | 'warning' | 'error', msg: string, leadName?: string, stepIndex?: number) => void;

/**
 * Shout when a campaign text carries a merge tag no lead field can fill.
 *
 * The renderer wipes such tags to an empty string — it has to, otherwise raw
 * `{{...}}` would reach the lead. The cost is that a typo'd tag is invisible:
 * on prod 2026-08 a whole launch went out as «Здравствуйте, Обратил внимание
 * на Kommo» and every monitoring line stayed green. This warning is the trace
 * that makes it visible in the campaign log (and countable in the digest).
 */
function warnUnknownPlaceholders(
  template: string,
  log: LogFn,
  leadName: string,
  stepIdx: number,
  what: string,
): void {
  const unknown = findUnknownPlaceholders(template);
  if (unknown.length === 0) return;
  log(
    'warning',
    `Пустая подстановка в тексте ${what}: ${unknown.map((v) => `{{${v}}}`).join(', ')} — ` +
      `таких переменных нет, они будут вырезаны и текст уйдёт без них. Доступны: ${supportedVarsHint()}`,
    leadName,
    stepIdx,
  );
}

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

  // The log() helper closes over this variable so every line written after
  // we've loaded the account row automatically gets attributed back to that
  // account. Lines emitted before account load (early returns about Unipile
  // settings, missing account_id, etc.) keep account_id=null.
  // Migration 20260521_0003 added the column; UI uses it for per-account
  // log views and error-count chips.
  let currentAccountId: string | null = null;

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
        account_id: currentAccountId,
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

  // Working-hours gate. Empty array (default for legacy campaigns predating
  // migration 20260608_0003) is treated as "always on" — no behaviour change
  // for existing launches. New campaigns with a real window will skip ticks
  // outside business hours instead of pushing invites/follow-ups around the
  // clock. Cheaper than the cooldown branch above because we exit BEFORE
  // loading Unipile creds / hitting the network.
  if (!isInWorkingHours(campaign.working_hours, campaign.timezone_offset)) {
    const tz = campaign.timezone_offset ?? 0;
    const tzSign = tz >= 0 ? '+' : '-';
    log(
      'info',
      `Тик пропущен — сейчас вне рабочего окна кампании (UTC${tzSign}${Math.abs(tz)}, окна: ${(campaign.working_hours ?? []).join(', ') || '—'}). Следующий тик попробует снова.`,
    );
    return { processed: 0, errors: 0 };
  }

  // Unipile credentials come from the shared env — the studio uses ONE
  // Unipile workspace across all specialists, so per-user BYOK in li_settings
  // is deprecated (see migration 20260708_0001_li_outreach_shared_unipile.sql).
  const unipileDsn = process.env.UNIPILE_DSN ?? '';
  const unipileApiKey = process.env.UNIPILE_API_KEY ?? '';
  if (!unipileDsn || !unipileApiKey) {
    console.warn(`[li-outreach] campaign ${campaignId}: UNIPILE_DSN / UNIPILE_API_KEY not set in env, skipping`);
    log('error', 'Тик пропущен — не сконфигурированы UNIPILE_DSN / UNIPILE_API_KEY в env на сервере. Обратитесь к админу.');
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
    // Attribute the upcoming log line to the account it's about.
    currentAccountId = account.id;
    const until = new Date(account.cooldown_until!).toLocaleString('ru-RU');
    log(
      'warning',
      `Тик пропущен — LinkedIn-аккаунт в отлёжке до ${until} (причина от LinkedIn: ${account.cooldown_reason ?? 'неизвестна'}). ` +
        `Это защита от бана: аккаунт сам выйдет из отлёжки в указанное время.`,
    );
    return { processed: 0, errors: 0 };
  }

  const client = new UnipileClient(
    unipileDsn,
    unipileApiKey,
    account?.unipile_account_id,
  );

  // AI personalization now goes through the centralized Requesty router only —
  // BYOK (per-user OpenAI keys from li_settings) is deprecated. Reading the
  // legacy `settings.openai_api_key` here used to silently break personalization
  // when a leftover OpenAI `sk-proj-...` key was in DB (Requesty rejects with
  // 401), and the user-facing settings UI no longer exposes that field anyway.
  // See migration 20260525_0003_li_outreach_drop_byok_keys.sql.
  const aiConfig = {
    apiKey: process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '',
    model: campaign.ai_model || 'openai/gpt-4o-mini',
  };

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

  // From here on every log() line will be attributed to this account in
  // li_campaign_logs.account_id, so the UI can filter per-account.
  currentAccountId = account.id;

  log('info', `Тик запущен — кампания «${campaign.name}», LinkedIn-аккаунт ${account.unipile_account_id ?? 'не указан'}. Ищу лидов, готовых к обработке.`);

  // Daily-counter reset is now atomic inside `li_campaign_increment_invite`
  // (see migration 20260420_0002). For the in-memory state used by the
  // limit-check and the "найдено N лидов / отправлено сегодня X" log line,
  // mirror that "fresh day → 0" view here so we don't briefly show last
  // night's count before the first invite of the day.
  const today = todayStr();
  if (campaign.last_invite_date !== today) {
    campaign.invites_sent_today = 0;
    log('info', `Наступил новый день — счётчик отправленных инвайтов обнулён (дневной лимит: ${campaign.daily_invite_limit} инвайтов)`);
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
    log('info', 'В этом тике нет лидов, готовых к обработке (все либо завершены, либо ждут своего времени по next_action_at)');
    return { processed: 0, errors: 0 };
  }

  const pendingCount = campaignLeads.filter((cl) => (cl as { status: string }).status === 'pending').length;
  const waitingCount = campaignLeads.filter((cl) => (cl as { status: string }).status === 'waiting').length;
  const inProgressCount = campaignLeads.filter((cl) => (cl as { status: string }).status === 'in_progress').length;
  log(
    'info',
    `Готов обработать ${campaignLeads.length} лидов в этом тике: ` +
      `${pendingCount} новых (pending), ${inProgressCount} в работе (in_progress), ${waitingCount} ждут следующего шага (waiting). ` +
      `Инвайтов отправлено сегодня: ${campaign.invites_sent_today} из лимита ${campaign.daily_invite_limit}.`,
  );

  // Early-exit when every lead in this batch sits on an `invite` step AND the
  // daily limit is already exhausted. Without this guard we'd spin through 20
  // no-op leads with a 60–400s sleep between each (see comment below) — ~80
  // minutes wasted while every other LinkedIn account waits its turn in the
  // outer worker loop. Leads on `wait` / `message` steps still need to be
  // touched (timers expire, follow-ups go out without consuming invites), so
  // we only skip when the *entire* batch is invite-bound.
  const limitReached = campaign.invites_sent_today >= campaign.daily_invite_limit;
  const allOnInviteStep = (campaignLeads as Array<LiCampaignLead & { lead: LiLead }>).every((cl) => {
    if (!cl.lead) return true;
    const stepIdx = cl.current_step;
    if (stepIdx >= steps.length) return false;
    return steps[stepIdx]?.type === 'invite';
  });
  if (limitReached && allOnInviteStep) {
    log(
      'info',
      `Дневной лимит инвайтов исчерпан (${campaign.invites_sent_today} из ${campaign.daily_invite_limit}), и все ${campaignLeads.length} лидов в этом тике ждут именно отправки инвайта. ` +
        `Тик закрываю без задержек — продолжим завтра, когда счётчик сбросится.`,
    );
    return { processed: 0, errors: 0 };
  }

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

    // `didNetworkWork` distinguishes "we actually hit LinkedIn (or AI)" from
    // "we just updated DB rows / hit the daily-limit guard / skipped". Only
    // the former needs the human-like inter-lead pause; otherwise the pause
    // is wasted clock time that blocks every other account in the parallel
    // worker. Defaults to true on exceptions — safer to over-pause than to
    // hammer LI after an error.
    let didNetworkWork = true;
    try {
      log('info', `Обработка шага ${stepIdx + 1}/${steps.length} (${step.type})`, cl.lead.name, stepIdx);
      didNetworkWork = await processStep(step, stepIdx, cl, cl.lead, campaign, client, aiConfig, db, log, account?.id ?? null);
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

    if (!didNetworkWork) continue;

    // Random delay between leads — only after a real LinkedIn/AI call.
    const delaySec = Math.floor(Math.random() * (campaign.max_delay - campaign.min_delay + 1)) + campaign.min_delay;
    log('info', `Пауза ${delaySec}с перед следующим лидом`);
    await randomDelay(campaign.min_delay, campaign.max_delay);
  }

  log('info', `Тик завершён: обработано ${processed}, ошибок ${errors}, всего в очереди было ${campaignLeads.length}`);
  return { processed, errors };
}

// ---- Step processors ----------------------------------------------------

/**
 * Returns true if this step actually hit LinkedIn/AI (sendInvite / startChat /
 * sendMessage / getProviderId / personalize). Returns false for pure DB-only
 * paths — limit reached, already-invited skip, no provider_id, wait timer set
 * or still pending. Caller uses this to decide whether to sleep the human-like
 * inter-lead pause.
 */
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
): Promise<boolean> {
  switch (step.type) {
    case 'invite':
      return processInviteStep(step, stepIdx, cl, lead, campaign, client, aiConfig, db, log, accountDbId);

    case 'wait':
      // Wait steps are pure DB bookkeeping — never any LinkedIn traffic.
      await processWaitStep(step, stepIdx, cl, db, log, lead.name);
      return false;

    case 'message':
    case 'follow_up':
      return processMessageStep(step, stepIdx, cl, lead, campaign, client, aiConfig, db, log, accountDbId);
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
): Promise<boolean> {
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
    return false;
  }

  // Defensive: lead already known to be 'already_invited' from a prior tick
  // (this campaign or another). Don't waste an API call to re-confirm what
  // LinkedIn will tell us again — advance the step so this lead can still
  // pick up the follow-up message if/when LinkedIn flips them to connected.
  // Same effect as the in-tick already_invited cooldown branch below.
  if (lead.status === 'already_invited') {
    log(
      'info',
      `Лид уже помечен «already_invited» в нашей базе — пропуск инвайта без API-вызова. Лид продолжает идти по воронке: если человек примет уже-висящий инвайт, фоллов-ап сработает.`,
      lead.name,
      stepIdx,
    );
    await db
      .from('li_campaign_leads')
      .update({
        current_step: stepIdx + 1,
        status:
          stepIdx + 1 < (campaign.steps?.length ?? 0) ? 'in_progress' : 'completed',
        updated_at: now,
      })
      .eq('id', cl.id);
    return false;
  }

  if (campaign.invites_sent_today >= campaign.daily_invite_limit) {
    log('warning', `Дневной лимит инвайтов достигнут (${campaign.invites_sent_today}/${campaign.daily_invite_limit}) — пропуск`, lead.name, stepIdx);
    return false;
  }

  let providerId = lead.linkedin_id;
  // Fallback: derive public_identifier from profile_url if missing.
  // Imports/scrapers often store profile_url but leave public_identifier null.
  const publicId = lead.public_identifier ?? extractPublicIdentifier(lead.profile_url);
  if (!lead.public_identifier && publicId) {
    const { error: piErr } = await db.from('li_leads').update({ public_identifier: publicId }).eq('id', lead.id);
    if (piErr) {
      // Non-fatal: we still have publicId in memory for this tick, but on the
      // next tick the resolver will run again — wasted work. Surface so ops
      // can spot DB connectivity / RLS issues.
      log('warning', `Не смог сохранить public_identifier «${publicId}» в БД — на следующем тике придётся резолвить заново: ${piErr.message}`, lead.name, stepIdx);
    } else {
      log('info', `public_identifier восстановлен из profile_url: ${publicId}`, lead.name, stepIdx);
    }
  }

  if (!providerId && publicId) {
    log('info', `Запрашиваю у Unipile внутренний LinkedIn ID для public_identifier «${publicId}»`, lead.name, stepIdx);
    try {
      providerId = await client.getProviderId(publicId);
      const { error: liErr } = await db.from('li_leads').update({ linkedin_id: providerId }).eq('id', lead.id);
      if (liErr) {
        log('warning', `LinkedIn ID получен (${providerId}), но не смог сохранить в БД — на следующем тике снова дёрнем Unipile: ${liErr.message}`, lead.name, stepIdx);
      } else {
        log('info', `LinkedIn ID получен и сохранён: ${providerId}`, lead.name, stepIdx);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // Account-level back-off takes priority (invitation_limit / restricted).
      const cooldown = detectAccountCooldownError(e);
      if (cooldown && accountDbId) {
        log('error', `Не смог получить LinkedIn ID через Unipile — ${msg}. Лид этим тиком обработать не получится.`, lead.name, stepIdx);
        const { cooldownUntil, error: cooldownErr } = await applyCooldownToAccount(db, accountDbId, cooldown.kind);
        const untilHuman = new Date(cooldownUntil).toLocaleString('ru-RU');
        if (cooldownErr) {
          log('error', `Сигнал «${cooldown.kind}» при резолве ID, но не смог записать отлёжку — ${cooldownErr}.`, lead.name, stepIdx);
        } else {
          log('warning', `Аккаунт уходит в отлёжку до ${untilHuman} (${describeCooldownReason(cooldown.kind)}).`, lead.name, stepIdx);
        }
        throw new AccountCooldownTriggered(cooldown.kind);
      }

      // Unresolvable recipient (deleted / invalid / private profile, bad
      // public_identifier from import) — Unipile returns 422 invalid_recipient
      // / "Recipient cannot…". Retrying never helps, so mark the lead 'skipped'
      // (dead) rather than letting it bubble to 'error', where it clutters the
      // campaign as a fixable failure and gets manually retried. Genuinely
      // transient resolve failures (timeout / 5xx / network) still throw →
      // 'error' as before. This is the auto-skip that keeps the funnel clean
      // (prod 2026-05/06: 82 such leads piled up as errors in "Stape продажа").
      if (/\b422\b|invalid_recipient|recipient cannot/i.test(msg)) {
        log('warning', `Профиль не резолвится (битый/удалён) — лид пропущен (skipped): ${msg}`, lead.name, stepIdx);
        await db
          .from('li_campaign_leads')
          .update({ status: 'skipped', error_message: msg, updated_at: now })
          .eq('id', cl.id);
        return false;
      }

      log('error', `Не смог получить LinkedIn ID через Unipile — ${msg}. Лид этим тиком обработать не получится.`, lead.name, stepIdx);
      throw new Error('Cannot resolve provider_id');
    }
  }
  if (!providerId) {
    log('error', 'Нет provider_id и public_identifier — невозможно отправить инвайт', lead.name, stepIdx);
    throw new Error('No provider_id and no public_identifier');
  }

  let message: string | null = step.message ?? null;
  // Персонализированный инвайт из CSV. Когда у кампании выставлен флаг
  // `use_custom_invites` и у конкретного лида есть свой `invite_text` (импорт
  // через /leads/import-with-invites), берём его как есть и пропускаем AI-
  // персонализацию: инвайт уже подготовлен индивидуально на стороне CSV.
  // Шаблоны `{{name}}` всё равно прогоняем — менеджер мог их использовать.
  // Fallback на `step.message` сохраняем: если лид без своего текста попал
  // в кампанию с включённым тумблером (например, лист подмешали из другого
  // источника) — отправляем шаблон, а не пустоту.
  const usedCustomInvite = Boolean(campaign.use_custom_invites && lead.invite_text);
  if (usedCustomInvite) {
    message = lead.invite_text!;
    log('info', 'Использую персонализированный инвайт из CSV-колонки (AI-персонализация пропущена)', lead.name, stepIdx);
  }
  if (message) {
    warnUnknownPlaceholders(message, log, lead.name, stepIdx, 'инвайта');
    message = parseMessageTemplate(message, leadToInfo(lead));
    if (!usedCustomInvite && campaign.use_ai && aiConfig.apiKey) {
      log('info', 'Прошу GPT персонализировать инвайт...', lead.name, stepIdx);
      const aiStart = Date.now();
      try {
        const before = message;
        const generated = await personalizeInviteMessage(message, leadToInfo(lead), aiConfig, campaign.ai_prompt_invite);
        const aiSec = ((Date.now() - aiStart) / 1000).toFixed(1);
        // Потолок ровно 300: столько принимает LinkedIn в приглашении. Без явного
        // потолка правило длины на этом пути недостижимо — общая формула даёт
        // минимум 400, а инвайт длиннее 300 всё равно не уйдёт.
        const problem = findAiOutputProblems(before, generated, { maxChars: 300 });
        if (problem) {
          // Инвайт режется до 297 знаков, поэтому сочинённое письмо ушло бы
          // человеку оборванным на полуслове. Лучше ровный шаблон.
          log(
            'warning',
            `GPT вернул не инвайт, а письмо (${problem.reason}) за ${aiSec}с — отправляю исходный шаблон.`,
            lead.name,
            stepIdx,
          );
        } else if (generated === before) {
          message = generated;
          log('warning', `GPT вернул шаблон без изменений за ${aiSec}с — отправляю как есть (возможно, упёрлись в лимит OpenRouter)`, lead.name, stepIdx);
        } else {
          message = generated;
          log('info', `GPT персонализировал инвайт за ${aiSec}с (${message.length} символов)`, lead.name, stepIdx);
        }
      } catch (err) {
        const aiSec = ((Date.now() - aiStart) / 1000).toFixed(1);
        log('error', `Ошибка GPT при персонализации инвайта за ${aiSec}с — отправляю шаблон без изменений: ${err instanceof Error ? err.message : String(err)}`, lead.name, stepIdx);
      }
    }
  }

  log('info', `Отправка инвайта${message ? ` (сообщение: "${message.slice(0, 50)}…")` : ' (без сообщения)'}`, lead.name, stepIdx);
  try {
    await client.sendInvite(providerId, message);
  } catch (e) {
    const cooldown = detectAccountCooldownError(e);
    if (cooldown) {
      // `already_invited` is a per-lead signal, NOT an account-wide back-off.
      // LinkedIn already has a pending invitation to this person — sent
      // earlier by us in another campaign, or by another tool. The invite is
      // still live on LinkedIn's side (typically ~3 weeks before expiry),
      // so the recipient could accept any day and we should still get the
      // chance to follow up.
      //
      // Therefore:
      //   - li_leads.status → dedicated 'already_invited' state (not
      //     'invited'), so the funnel doesn't double-count it as an invite
      //     we sent now — the LinkedIn account dashboard wouldn't include
      //     it in "Приглашений отправлено" either.
      //   - The campaign-lead row STILL advances to the next step (wait →
      //     message). The follow-up message step has its own guard
      //     (sendMessageStep) that defers a day at a time while the lead
      //     hasn't accepted — so if the existing invite is accepted later,
      //     the message will go out then. That guard also recognises
      //     'already_invited' (parallel to 'invited') after this change.
      //   - Daily invite quota is NOT consumed (no API send happened).
      //   - Account is NOT parked (prod 2026-04: parking 15min on every
      //     already_invited dropped throughput from 25/day to ~1/15min on
      //     historically-invited lists — see accountCooldown.ts).
      if (cooldown.kind === 'already_invited') {
        log(
          'warning',
          `LinkedIn ответил «already_invited» — у нас уже есть активный инвайт на этого лида (отправлен ранее, в другой кампании или вручную). ` +
            `Дневной лимит не тратится. Лид помечен «already_invited» и продолжает идти по воронке: если человек примет инвайт в ближайшие ~3 недели, сработает фоллов-ап.`,
          lead.name,
          stepIdx,
        );
        await db.from('li_leads').update({ status: 'already_invited', updated_at: now }).eq('id', lead.id);
        await db
          .from('li_campaign_leads')
          .update({
            current_step: stepIdx + 1,
            status:
              stepIdx + 1 < (campaign.steps?.length ?? 0) ? 'in_progress' : 'completed',
            updated_at: now,
          })
          .eq('id', cl.id);
        // sendInvite() did hit LinkedIn (it returned the already_invited error),
        // so honour the human-like inter-lead pause.
        return true;
      }

      // invitation_limit / account_restricted — these ARE account-wide signals.
      // Park the account so every campaign + scraper using it stops hammering
      // the API for COOLDOWN_MINUTES[kind] minutes; abort the rest of the tick.
      if (accountDbId) {
        const { cooldownUntil, error: cooldownErr } = await applyCooldownToAccount(db, accountDbId, cooldown.kind);
        const untilHuman = new Date(cooldownUntil).toLocaleString('ru-RU');
        if (cooldownErr) {
          // The write failed — we'll re-throw the cooldown signal so the tick
          // still exits, but the account isn't actually parked in the DB. Loud
          // ERROR so the operator notices and can park it manually.
          log(
            'error',
            `LinkedIn вернул сигнал «${cooldown.kind}», но не смог записать отлёжку аккаунта в базу данных — ${cooldownErr}. ` +
              `Аккаунт может продолжать получать запросы и копить нарушения. Поставьте отлёжку вручную через UI или БД.`,
            lead.name,
            stepIdx,
          );
        } else {
          log(
            'warning',
            `LinkedIn ограничил аккаунт (${cooldown.kind} — ${describeCooldownReason(cooldown.kind)}). ` +
              `Аккаунт уходит в отлёжку до ${untilHuman}, остальные кампании на этом аккаунте тоже ждут.`,
            lead.name,
            stepIdx,
          );
        }
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
  return true;
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
  accountDbId: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();

  // NOTE: We intentionally do NOT short-circuit when `cl.welcome_sent_at` is set.
  // An earlier version skipped the first message-step entirely if welcome had
  // been delivered through the connection_accepted webhook, on the assumption
  // that welcome and the first follow-up are duplicates of the same intent.
  // In practice operators configure welcome and the first message-step with
  // *different* content (welcome = "thanks for connecting, here's who we are";
  // first message = real follow-up with examples 2 days later) — see prod
  // SaaS Никита 2026-05. The dedup silently swallowed the real follow-up and
  // made it look like the runner had stopped working. If a campaign really
  // does want a single message, the operator should leave either
  // `welcome_message` empty or omit the first message step — not have the
  // runner second-guess intent. `welcome_sent_at` is still recorded on the
  // row for analytics / audit, just not used to suppress this step.

  // Connection guard. Without it, after a 2-day `wait` step we used to call
  // startChat() blindly and LinkedIn returned `errors/no_connection_with_recipient`
  // for ~1499 leads in a single prod week (Apr 2026). Branch on lead.status:
  //
  //   - 'invited' / 'already_invited' → invite is live on LinkedIn (sent
  //                              by us this run, or pre-existing from
  //                              another campaign / tool) but accept not
  //                              yet observed via webhook; defer one day
  //                              so a late accept can still be picked up.
  //   - 'new'                  → we never even sent an invite — something went sideways
  //                              earlier, skip permanently.
  //   - 'connected' / others   → fall through to startChat — chat just wasn't opened yet.
  if (!lead.chat_id) {
    if (lead.status === 'invited' || lead.status === 'already_invited') {
      const deferAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db
        .from('li_campaign_leads')
        .update({ status: 'waiting', next_action_at: deferAt, updated_at: now })
        .eq('id', cl.id);
      log(
        'info',
        `Шаг message пропущен: коннект ещё не подтверждён (lead.status=${lead.status}). Повторим ${new Date(deferAt).toLocaleString('ru-RU')}.`,
        lead.name,
        stepIdx,
      );
      return false;
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
      return false;
    }
    if (!lead.linkedin_id) {
      log('warning', 'Нет chat_id и linkedin_id — невозможно отправить сообщение, пропуск', lead.name, stepIdx);
      return false;
    }
  }

  // Build the final outgoing text BEFORE deciding between startChat / sendMessage.
  // Previously startChat (the "no chat_id yet" branch) received the raw
  // `step.message`, so the first line of any chat opened via runner went out
  // literally as "Hi {{first_name}}!"; the parseMessageTemplate + GPT call ran
  // afterwards and produced a *second*, properly rendered message via
  // sendMessage. End result for the lead: two near-identical follow-ups in a
  // row, the first one un-personalized. See prod 2026-05 reports.
  let message = step.message ?? '';
  warnUnknownPlaceholders(message, log, lead.name, stepIdx, 'сообщения');
  message = parseMessageTemplate(message, leadToInfo(lead));
  if (campaign.use_ai && campaign.use_ai_followup && aiConfig.apiKey) {
    const historyEntries = (lead.conversation_history ?? []) as Array<{ role: string; content: string }>;
    log('info', `Прошу GPT персонализировать follow-up (учитываю историю из ${historyEntries.length} сообщ.)`, lead.name, stepIdx);
    const aiStart = Date.now();
    try {
      const before = message;
      const generated = await personalizeFollowUp(message, leadToInfo(lead), historyEntries, aiConfig, campaign.ai_prompt_chat);
      const aiSec = ((Date.now() - aiStart) / 1000).toFixed(1);
      const problem = findAiOutputProblems(before, generated);
      if (problem) {
        // Отправляем шаблон оператора. Молча брать ответ модели нельзя: 19.08.2026
        // так ушло письмо с подписью `[Ваше имя]` человеку из Oracle — см. aiOutputGuard.ts.
        log(
          'warning',
          `GPT вернул не сообщение, а письмо (${problem.reason}) за ${aiSec}с — отправляю исходный шаблон. ` +
            `Проверьте промпт кампании: для персонализации нужен промпт про правку текста, а не про ответы в диалоге.`,
          lead.name,
          stepIdx,
        );
      } else if (generated === before) {
        message = generated;
        log('warning', `GPT вернул шаблон follow-up без изменений за ${aiSec}с — отправляю как есть`, lead.name, stepIdx);
      } else {
        message = generated;
        log('info', `GPT персонализировал follow-up за ${aiSec}с (${message.length} символов)`, lead.name, stepIdx);
      }
    } catch (err) {
      const aiSec = ((Date.now() - aiStart) / 1000).toFixed(1);
      log('error', `Ошибка GPT при персонализации follow-up за ${aiSec}с — отправляю шаблон: ${err instanceof Error ? err.message : String(err)}`, lead.name, stepIdx);
    }
  }

  if (!message.trim()) {
    log('warning', 'Пустое сообщение после генерации — пропуск', lead.name, stepIdx);
    // If AI-personalization was attempted above it already hit the LLM — but
    // we still treat this as no-network for pacing purposes: an empty message
    // is operator-error, not LI traffic. The next tick will retry.
    return false;
  }

  // Этот текст человеку уже уходил — второй раз не отправляем.
  //
  // Гард от повтора стоял только на шаге invite (processInviteStep смотрит на
  // lead.status), а chat_id у лида один на человека: две running-кампании на
  // пересекающихся лидах писали в один и тот же чат, и получатель видел, как
  // собеседник дважды присылает один и тот же абзац. 15–17.08.2026 так вышло у
  // четверых, один из них через пять минут ответил «Не интересно». Кампанию
  // остановили руками, 20.08 запустили заново — пересечение вернулось на 153
  // лидах. Договорённость «один человек — одна активная кампания» держится на
  // внимании оператора, поэтому нужен отказ в коде.
  //
  // Лид снимается с кампании целиком, а не просто пропускает шаг: иначе
  // следующий message-шаг продублирует так же. Тот, кто отправил первым,
  // продолжает вести человека — здесь мы лишь уступаем.
  if (isRepeatOfOurs(message, lead.conversation_history as RepeatCheckMessage[] | null)) {
    await db
      .from('li_campaign_leads')
      .update({
        status: 'skipped',
        error_message: 'Этот текст лиду уже отправляли — снят с кампании во избежание дубля',
        next_action_at: null,
        updated_at: now,
      })
      .eq('id', cl.id);
    log(
      'warning',
      `Дубль предотвращён: этот текст лиду уже отправляли, снимаю его с кампании. ` +
        `Проверьте, не идёт ли этот человек сразу в двух активных кампаниях.`,
      lead.name,
      stepIdx,
    );
    return false;
  }

  // Two delivery paths, same prepared `message`:
  //   - existing chat → sendMessage
  //   - no chat yet   → startChat opens it AND delivers `message` as the first
  //                     line in one call; we MUST NOT fall through to
  //                     sendMessage afterwards or LI receives the same text twice.
  // Both branches share the same cooldown contract: an account-level error
  // (invitation_limit / account_restricted) parks the account in the DB and
  // aborts the rest of the tick via AccountCooldownTriggered so we don't keep
  // banging on a parked account.
  if (!lead.chat_id) {
    log('info', `Нет chat_id — открываю чат через Unipile с готовым сообщением: "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"`, lead.name, stepIdx);
    try {
      const chatResult = await client.startChat(lead.linkedin_id!, message);
      const newChatId = String(chatResult.id ?? chatResult.chat_id ?? '');
      if (!newChatId) {
        log('warning', 'startChat не вернул chat_id — сообщение, скорее всего, не доставлено', lead.name, stepIdx);
        return true;
      }
      lead.chat_id = newChatId;
      await db
        .from('li_leads')
        .update({ chat_id: newChatId, status: 'connected', updated_at: now })
        .eq('id', lead.id);
      log('info', `Чат создан (chat_id: ${newChatId}), сообщение отправлено как initial text`, lead.name, stepIdx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('warning', `Не удалось начать чат (ещё нет коннекта?): ${msg}`, lead.name, stepIdx);
      const cooldown = detectAccountCooldownError(e);
      if (cooldown && accountDbId) {
        const { cooldownUntil, error: cooldownErr } = await applyCooldownToAccount(db, accountDbId, cooldown.kind);
        const untilHuman = new Date(cooldownUntil).toLocaleString('ru-RU');
        if (!cooldownErr) {
          log('warning', `Аккаунт уходит в отлёжку до ${untilHuman} (${describeCooldownReason(cooldown.kind)}).`, lead.name, stepIdx);
        }
        throw new AccountCooldownTriggered(cooldown.kind);
      }
      // Non-cooldown failure — startChat() did hit LinkedIn, keep the human-like pause.
      return true;
    }
  } else {
    log('info', `Отправка сообщения: "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"`, lead.name, stepIdx);
    try {
      await client.sendMessage(lead.chat_id, message);
    } catch (e) {
      const cooldown = detectAccountCooldownError(e);
      if (cooldown && accountDbId) {
        const { cooldownUntil, error: cooldownErr } = await applyCooldownToAccount(db, accountDbId, cooldown.kind);
        const untilHuman = new Date(cooldownUntil).toLocaleString('ru-RU');
        if (!cooldownErr) {
          log('warning', `Аккаунт уходит в отлёжку до ${untilHuman} (${describeCooldownReason(cooldown.kind)}).`, lead.name, stepIdx);
        }
        throw new AccountCooldownTriggered(cooldown.kind);
      }
      throw e;
    }
  }

  const history = [...(lead.conversation_history ?? []), { role: 'assistant', content: message, ts: now }];
  await db.from('li_leads').update({ conversation_history: history, status: 'messaged', last_activity: now, updated_at: now }).eq('id', lead.id);

  const totalSteps = (campaign.steps?.length ?? 0);
  const isLast = stepIdx + 1 >= totalSteps;
  await db
    .from('li_campaign_leads')
    .update({ current_step: stepIdx + 1, status: isLast ? 'completed' : 'in_progress', updated_at: now })
    .eq('id', cl.id);

  log('info', `Сообщение отправлено${isLast ? ' (последний шаг — лид завершён)' : ''}`, lead.name, stepIdx);
  return true;
}
