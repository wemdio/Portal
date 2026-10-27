import type { SupabaseClient } from '@supabase/supabase-js';
import { qualifyReply } from '@/lib/instantly/leadQualifier';
import { loadSenderThread } from './context';
import { loadCampaignSettings, type LeadSettings } from './settings';
import { isClientPartyReply, withProjectLeadSettings } from './projectScope';
import { buildLeadMessage, leadTelegramConfig, sendLeadMessage, threadUrl, type LeadTelegramConfig } from './telegram';
import { processSenderAutoLeadCrm } from './crm';
import { runSenderAiQualifier, type AiPassResult } from '@/lib/senderAiQualifier/engine';

/**
 * Один круг квалификатора ответов «Рассылки»
 * (docs/superpowers/specs/2026-09-29-sender-reply-leads-design.md).
 *
 * 1. Новые живые ответы из очереди (представление sender_lead_queue) занимаем
 *    вставкой строки оценки — on conflict do nothing: кто не вставил, тот не
 *    платит ИИ за тот же ответ.
 * 2. Оцениваем правилами квалификатора Instantly с готовой перепиской из нашей
 *    базы и правилом папки.
 * 3. Лида шлём в ТГ-чат — не больше одного сообщения на переписку.
 * 4. Доставленных лидов RU/EN автоаутрича ставим в очередь AMO.
 *
 * Сбой ИИ не теряет ответ: строка остаётся pending с растущей паузой, после
 * пяти попыток — error с повтором в ежечасном обходе, максимум 48 часов.
 * Затем — окончательная ошибка с последней причиной. Сбой ТГ не трогает
 * оценку: доставка повторяется отдельно.
 */

const BATCH = 20;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MIN = [1, 5, 15, 60];
/** Строку «в работе» без следующей попытки считаем брошенной (упал процесс) через столько минут. */
const STALE_PENDING_MIN = 15;
export const SENDER_LEADS_RECOVERY_INTERVAL_MS = 60 * 60_000;
const RETRY_WINDOW_MS = 48 * 60 * 60_000;

export type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface SenderLeadsAi {
  apiKey: string;
  model?: string;
}

export function senderLeadsAi(env: NodeJS.ProcessEnv = process.env): SenderLeadsAi | null {
  const apiKey = (env.SENDER_LEADS_AI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const model = (env.SENDER_LEADS_AI_MODEL ?? '').trim();
  return model ? { apiKey, model } : { apiKey };
}

interface QualificationRow {
  reply_id: string;
  recipient_id: string;
  campaign_id: string;
  attempts: number;
  status: 'pending' | 'error';
  updated_at: string;
  retry_deadline_at: string | null;
  last_error: string | null;
}

const QUALIFICATION_SELECT = 'reply_id, recipient_id, campaign_id, attempts, status, updated_at, retry_deadline_at, last_error';

function exhaustedError(lastError: string | null): string {
  return `Не удалось квалифицировать ответ за 48 часов. Автоматические попытки остановлены. Последняя причина: ${lastError?.trim() || 'причина последнего сбоя не сохранена'}`;
}

function retryAt(attempts: number): string {
  const minutes = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** Новые ответы из очереди → строки оценки (pending). Возвращает занятые. */
async function claimNew(db: SupabaseClient): Promise<QualificationRow[]> {
  const { data, error } = await db
    .from('sender_lead_queue')
    .select('reply_id, recipient_id, campaign_id')
    .order('created_at')
    .limit(BATCH);
  if (error) throw new Error(`sender_lead_queue: ${error.message}`);
  const queue = (data ?? []) as Array<{ reply_id: string; recipient_id: string; campaign_id: string }>;
  if (!queue.length) return [];

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await db
    .from('sender_reply_qualifications')
    .upsert(
      queue.map((q) => ({
        ...q, status: 'pending', attempts: 0, updated_at: now,
        retry_deadline_at: new Date(Date.now() + RETRY_WINDOW_MS).toISOString(),
        next_attempt_at: new Date(Date.now() + STALE_PENDING_MIN * 60_000).toISOString(),
      })),
      { onConflict: 'reply_id', ignoreDuplicates: true },
    )
    .select(QUALIFICATION_SELECT);
  if (insertError) throw new Error(`sender_reply_qualifications insert: ${insertError.message}`);
  return (inserted ?? []) as QualificationRow[];
}

/** Ответы, которым пора повторить оценку, и брошенные упавшим процессом. */
async function dueRetries(db: SupabaseClient, exclude: Set<string>): Promise<QualificationRow[]> {
  const now = new Date();
  const stale = new Date(now.getTime() - STALE_PENDING_MIN * 60_000).toISOString();
  const { data, error } = await db
    .from('sender_reply_qualifications')
    .select(QUALIFICATION_SELECT)
    .in('status', ['pending', 'error'])
    .is('retry_exhausted_at', null)
    // next_attempt_at — также срок владения выполняемой попыткой. После
    // падения процесса подхватываем и строки с attempts > 0 без расписания.
    // Истечение 48 часов закрываем и без ключа ИИ, не ожидая следующего
    // часового обхода. Действующую попытку не отбираем до конца её lease.
    .or(`and(status.eq.pending,or(next_attempt_at.lte.${now.toISOString()},and(next_attempt_at.is.null,updated_at.lte.${stale}))),and(retry_deadline_at.lte.${now.toISOString()},or(status.eq.error,next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}))`)
    .order('next_attempt_at')
    .limit(BATCH);
  if (error) throw new Error(`sender_reply_qualifications retries: ${error.message}`);
  return ((data ?? []) as QualificationRow[]).filter((r) => !exclude.has(r.reply_id));
}

/** Временные ошибки проверяем раз в час; окончательные больше не подхватываются. */
async function dueRecovery(db: SupabaseClient): Promise<QualificationRow[]> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('sender_reply_qualifications')
    .select(QUALIFICATION_SELECT)
    .eq('status', 'error')
    .is('retry_exhausted_at', null)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order('updated_at')
    .limit(BATCH);
  if (error) throw new Error(`sender_reply_qualifications recovery: ${error.message}`);
  return (data ?? []) as QualificationRow[];
}

/** Сверка версии не даёт двум процессам одновременно оплатить одну попытку. */
async function claimAttempt(db: SupabaseClient, row: QualificationRow): Promise<boolean> {
  const claimedAt = Math.max(Date.now(), Date.parse(row.updated_at) + 1);
  const now = new Date(claimedAt).toISOString();
  const deadline = row.retry_deadline_at ?? new Date(claimedAt + RETRY_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from('sender_reply_qualifications')
    .update({
      status: 'pending', updated_at: now,
      retry_deadline_at: deadline,
      next_attempt_at: new Date(claimedAt + STALE_PENDING_MIN * 60_000).toISOString(),
    })
    .eq('reply_id', row.reply_id)
    .eq('status', row.status)
    .eq('updated_at', row.updated_at)
    .is('retry_exhausted_at', null)
    .select('reply_id')
    .maybeSingle();
  if (error) throw new Error(`sender_reply_qualifications claim: ${error.message}`);
  if (data) row.retry_deadline_at = deadline;
  return Boolean(data);
}

async function markRow(db: SupabaseClient, replyId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('sender_reply_qualifications')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('reply_id', replyId);
  if (error) throw new Error(`sender_reply_qualifications update: ${error.message}`);
}

/** Итог по переписке — если человек не поставил метку руками. */
async function setRecipientVerdict(
  db: SupabaseClient, row: QualificationRow, replyAt: string, isLead: boolean,
): Promise<boolean> {
  // Восстановленная старая ошибка не меняет итог более позднего ответа и
  // не порождает уведомление о лиде, который уже получил более свежую оценку.
  const { data: newer, error: newerError } = await db
    .from('sender_reply_qualifications')
    .select('reply_id, sender_replies!inner(received_at, created_at)')
    .eq('recipient_id', row.recipient_id)
    .neq('reply_id', row.reply_id)
    .in('status', ['lead', 'not_lead'])
    .or(`received_at.gt.${replyAt},and(received_at.is.null,created_at.gt.${replyAt})`, { referencedTable: 'sender_replies' })
    .limit(1);
  if (newerError) throw new Error(`sender_reply_qualifications newer: ${newerError.message}`);
  if (newer?.length) return false;
  const { error } = await db
    .from('sender_recipients')
    .update({ lead_verdict: isLead ? 'lead' : 'not_lead', lead_verdict_source: 'ai', lead_verdict_at: new Date().toISOString() })
    .eq('id', row.recipient_id)
    .or('lead_verdict_source.is.null,lead_verdict_source.eq.ai');
  if (error) throw new Error(`sender_recipients verdict: ${error.message}`);
  return true;
}

async function qualifyOne(
  db: SupabaseClient,
  row: QualificationRow,
  settings: LeadSettings,
  ai: SenderLeadsAi | null,
  log: Log,
): Promise<boolean> {
  const deadline = Date.parse(row.retry_deadline_at!);
  if (Date.now() >= deadline) {
    const message = exhaustedError(row.last_error);
    await markRow(db, row.reply_id, {
      status: 'error', retry_exhausted_at: new Date().toISOString(),
      next_attempt_at: null, last_error: message,
    });
    log('error', `Ответ ${row.reply_id}: ${message}`);
    return false;
  }
  if (!settings.enabled) {
    await markRow(db, row.reply_id, { status: 'skipped', last_error: 'квалификация папки выключена' });
    return false;
  }
  const attempts = row.attempts + 1;
  try {
    // Проект кампании Движка не прочитан — ждём, а не оцениваем без брифа.
    if (settings.projectError) throw new Error(settings.projectError);
    if (!ai) throw new Error('Ключ ИИ для квалификации не настроен (SENDER_LEADS_AI_API_KEY)');
    const thread = await loadSenderThread(db, row.reply_id, row.recipient_id);
    if (!thread) {
      await markRow(db, row.reply_id, { status: 'skipped', attempts, last_error: 'ответ или переписка не найдены' });
      return false;
    }
    // После передачи клиент в копии и может ответить в ту же переписку: его
    // письмо — не ответ лида. Итог переписки (лида) не трогаем, ИИ не зовём.
    if (settings.route === 'project' && isClientPartyReply(thread.replyFrom, settings.clientParty)) {
      await markRow(db, row.reply_id, {
        status: 'skipped', attempts, next_attempt_at: null,
        last_error: 'ответ клиента проекта (адрес «Передачи лида»), а не лида',
      });
      return false;
    }
    const verdict = await qualifyReply(
      row.campaign_id,
      thread.replyFrom ?? '',
      null,
      {
        apiKey: ai.apiKey,
        ...(ai.model ? { model: ai.model } : {}),
        // Пустая строка, а не null: при null квалификатор пошёл бы искать бриф
        // кампании в базе Instantly. Контекст оффера — наши собственные письма,
        // у кампаний Движка вертикалей — ещё и бриф проекта.
        briefText: settings.briefText ?? '',
        leadCriteria: settings.criteria,
        prefetchedContext: thread.context,
        maxRetries: 1,
      },
    );
    await markRow(db, row.reply_id, {
      status: verdict.isLead ? 'lead' : 'not_lead',
      ai_reason: verdict.reason?.slice(0, 2000) ?? null,
      interest_signals: verdict.interestSignals ?? [],
      criteria_used: Boolean(settings.criteria),
      model: ai.model ?? 'default',
      attempts,
      next_attempt_at: null,
      last_error: null,
      qualified_at: new Date().toISOString(),
    });
    const applied = await setRecipientVerdict(db, row, thread.context.replyEmail.timestamp_email!, verdict.isLead);
    if (!applied) {
      await markRow(db, row.reply_id, { tg_attempts: MAX_ATTEMPTS, tg_error: 'есть более свежая оценка переписки' });
    }
    return verdict.isLead;
  } catch (err) {
    const message = errorText(err);
    const final = attempts >= MAX_ATTEMPTS;
    const expired = Date.now() >= deadline;
    log(final ? 'error' : 'warn', `Оценка ответа ${row.reply_id} не удалась (попытка ${attempts}): ${message}`);
    await markRow(db, row.reply_id, {
      status: expired || final ? 'error' : 'pending',
      attempts,
      retry_exhausted_at: expired ? new Date().toISOString() : null,
      next_attempt_at: expired ? null : new Date(Math.min(
        deadline,
        final ? Date.now() + SENDER_LEADS_RECOVERY_INTERVAL_MS : Date.parse(retryAt(attempts)),
      )).toISOString(),
      last_error: expired ? exhaustedError(message) : message,
    });
    return false;
  }
}

/** Лиды, ещё не доставленные в чат, у переписок, по которым в чат ещё не писали. */
async function deliverLeads(db: SupabaseClient, tg: LeadTelegramConfig, log: Log): Promise<number> {
  const { data, error } = await db
    .from('sender_reply_qualifications')
    .select('reply_id, recipient_id, campaign_id, ai_reason, tg_attempts, updated_at')
    .eq('status', 'lead')
    .is('tg_sent_at', null)
    .lt('tg_attempts', MAX_ATTEMPTS)
    .order('qualified_at')
    .limit(BATCH);
  if (error) throw new Error(`sender_reply_qualifications leads: ${error.message}`);
  const rows = (data ?? []) as Array<{
    reply_id: string; recipient_id: string; campaign_id: string; ai_reason: string | null; tg_attempts: number; updated_at: string;
  }>;
  if (!rows.length) return 0;

  const settings = await loadCampaignSettings(db, rows.map((r) => r.campaign_id));
  let sent = 0;
  for (const row of rows) {
    // Пауза после сбоя доставки: та же лесенка, что у оценки.
    if (row.tg_attempts > 0 && Date.parse(row.updated_at) > Date.now() - (RETRY_DELAYS_MIN[Math.min(row.tg_attempts - 1, 3)] * 60_000)) continue;

    const campaign = settings.get(row.campaign_id);
    const skip = async (reason: string) => markRow(db, row.reply_id, { tg_attempts: MAX_ATTEMPTS, tg_error: reason });
    if (!campaign) { await skip('рассылка не найдена'); continue; }
    // Лид кампании Движка вертикалей уходит карточкой специалисту проекта (projectLeadCards), не в чат продаж.
    if (campaign.veProjectId) { await skip('лид проекта — карточка специалисту'); continue; }
    if (!campaign.settings.telegram) { await skip('отправка в чат выключена у папки'); continue; }

    // Пока квалифицирующий ИИ ведёт переписку, лид в чат не идёт; после
    // передачи — только строка его передачи. Когда разговор кончился (не
    // ответил, закрыт, остановлен, сбой), новые лиды идут прежним путём.
    const { data: conv, error: convError } = await db.from('sender_ai_conversations')
      .select('state, handoff_reply_id').eq('recipient_id', row.recipient_id).maybeSingle();
    if (convError) { log('warn', `ТГ: разговор ИИ ${row.recipient_id} не прочитан: ${convError.message}`); continue; }
    if (conv && (conv.state === 'active' || (conv.state === 'handed_off' && conv.handoff_reply_id !== row.reply_id))) {
      await skip('Переписку ведёт ИИ');
      continue;
    }

    const [{ data: recipient }, { data: alreadySent }] = await Promise.all([
      db.from('sender_recipients').select('email, name, lead_verdict, lead_verdict_source').eq('id', row.recipient_id).maybeSingle(),
      db.from('sender_reply_qualifications').select('reply_id').eq('recipient_id', row.recipient_id).not('tg_sent_at', 'is', null).limit(1),
    ]);
    if (!recipient) { await skip('получатель удалён'); continue; }
    if (alreadySent?.length) { await skip('по этой переписке в чат уже писали'); continue; }
    if (recipient.lead_verdict_source === 'manual' && recipient.lead_verdict === 'not_lead') {
      await skip('человек отметил «не лид»');
      continue;
    }

    try {
      const thread = await loadSenderThread(db, row.reply_id, row.recipient_id);
      const text = buildLeadMessage({
        folderName: campaign.settings.folderName,
        campaignName: campaign.campaignName,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        replyFrom: thread?.replyFrom ?? null,
        replySubject: thread?.replySubject ?? null,
        replyBody: thread?.replyBody ?? '',
        aiReason: row.ai_reason,
        threadUrl: threadUrl(row.recipient_id),
      });
      const messageId = await sendLeadMessage(tg, text);
      await markRow(db, row.reply_id, {
        tg_sent_at: new Date().toISOString(), tg_message_id: messageId,
        tg_message_text: text, tg_error: null,
      });
      sent += 1;
    } catch (err) {
      const message = errorText(err);
      log('warn', `ТГ: лид ${row.reply_id} не доставлен (попытка ${row.tg_attempts + 1}): ${message}`);
      await markRow(db, row.reply_id, { tg_attempts: row.tg_attempts + 1, tg_error: message });
    }
  }
  return sent;
}

export interface PassResult {
  qualified: number;
  leads: number;
  delivered: number;
  crm: number;
  ai: AiPassResult;
  recoveryHasMore: boolean;
}

export async function runSenderLeadsPass(
  db: SupabaseClient, log: Log, recoverErrors = false,
): Promise<PassResult> {
  const ai = senderLeadsAi();
  const result: PassResult = {
    qualified: 0, leads: 0, delivered: 0, crm: 0, recoveryHasMore: false,
    ai: { started: 0, letters: 0, handedOff: 0, closed: 0 },
  };

  const fresh = await claimNew(db);
  const retries = await dueRetries(db, new Set(fresh.map((r) => r.reply_id)));
  const recovery = recoverErrors ? await dueRecovery(db) : [];
  // Большой хвост разбираем порциями между обычными кругами, а не
  // оставляем всё сверх первой двадцатки ждать ещё час.
  result.recoveryHasMore = recovery.length === BATCH;
  const rows = [...new Map([...fresh, ...retries, ...recovery].map((row) => [row.reply_id, row])).values()];
  if (recovery.length) log('info', `Ежечасный обход: найдено ${recovery.length} ответов с ошибкой квалификации`);
  if (rows.length) {
    const settings = await withProjectLeadSettings(db, await loadCampaignSettings(db, rows.map((r) => r.campaign_id)));
    for (const row of rows) {
      if (!await claimAttempt(db, row)) continue;
      const campaign = settings.get(row.campaign_id);
      if (!campaign) {
        await markRow(db, row.reply_id, { status: 'skipped', last_error: 'рассылка не найдена' });
        continue;
      }
      const isLead = await qualifyOne(db, row, campaign.settings, ai, log);
      result.qualified += 1;
      if (isLead) result.leads += 1;
    }
  }

  // До доставки: лид, которого берёт ИИ, не должен уйти в чат в этом же круге.
  // Сбой ИИ не ломает доставку — без разговора лид идёт прежним путём.
  try {
    result.ai = await runSenderAiQualifier(db, log);
  } catch (err) {
    log('error', 'Круг квалифицирующего ИИ упал', err);
  }

  const tg = leadTelegramConfig();
  if (tg) result.delivered = await deliverLeads(db, tg, log);
  result.crm = await processSenderAutoLeadCrm(db, log);
  return result;
}
