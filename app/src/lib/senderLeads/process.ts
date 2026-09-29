import type { SupabaseClient } from '@supabase/supabase-js';
import { qualifyReply } from '@/lib/instantly/leadQualifier';
import { loadSenderThread } from './context';
import { loadCampaignSettings, type LeadSettings } from './settings';
import { buildLeadMessage, leadTelegramConfig, sendLeadMessage, threadUrl, type LeadTelegramConfig } from './telegram';

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
 *
 * Сбой ИИ не теряет ответ: строка остаётся pending с растущей паузой, после
 * пяти попыток — error. Сбой ТГ не трогает оценку: доставка повторяется
 * отдельно.
 */

const BATCH = 20;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MIN = [1, 5, 15, 60];
/** Строку «в работе» без следующей попытки считаем брошенной (упал процесс) через столько минут. */
const STALE_PENDING_MIN = 15;

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
      queue.map((q) => ({ ...q, status: 'pending', attempts: 0, next_attempt_at: now })),
      { onConflict: 'reply_id', ignoreDuplicates: true },
    )
    .select('reply_id, recipient_id, campaign_id, attempts');
  if (insertError) throw new Error(`sender_reply_qualifications insert: ${insertError.message}`);
  return (inserted ?? []) as QualificationRow[];
}

/** Ответы, которым пора повторить оценку, и брошенные упавшим процессом. */
async function dueRetries(db: SupabaseClient, exclude: Set<string>): Promise<QualificationRow[]> {
  const now = new Date();
  const stale = new Date(now.getTime() - STALE_PENDING_MIN * 60_000).toISOString();
  const { data, error } = await db
    .from('sender_reply_qualifications')
    .select('reply_id, recipient_id, campaign_id, attempts')
    .eq('status', 'pending')
    // Повтор после сбоя — по своему времени; строка без попыток, застрявшая
    // «в работе», — только когда явно брошена, иначе её взял бы второй круг,
    // пока первый ещё ждёт ответа ИИ.
    .or(`and(attempts.gt.0,next_attempt_at.lte.${now.toISOString()}),and(attempts.eq.0,updated_at.lte.${stale})`)
    .order('next_attempt_at')
    .limit(BATCH);
  if (error) throw new Error(`sender_reply_qualifications retries: ${error.message}`);
  return ((data ?? []) as QualificationRow[]).filter((r) => !exclude.has(r.reply_id));
}

async function markRow(db: SupabaseClient, replyId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('sender_reply_qualifications')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('reply_id', replyId);
  if (error) throw new Error(`sender_reply_qualifications update: ${error.message}`);
}

/** Итог по переписке — если человек не поставил метку руками. */
async function setRecipientVerdict(db: SupabaseClient, recipientId: string, isLead: boolean): Promise<void> {
  const { error } = await db
    .from('sender_recipients')
    .update({ lead_verdict: isLead ? 'lead' : 'not_lead', lead_verdict_source: 'ai', lead_verdict_at: new Date().toISOString() })
    .eq('id', recipientId)
    .or('lead_verdict_source.is.null,lead_verdict_source.eq.ai');
  if (error) throw new Error(`sender_recipients verdict: ${error.message}`);
}

async function qualifyOne(
  db: SupabaseClient,
  row: QualificationRow,
  settings: LeadSettings,
  ai: SenderLeadsAi,
  log: Log,
): Promise<boolean> {
  if (!settings.enabled) {
    await markRow(db, row.reply_id, { status: 'skipped', last_error: 'квалификация папки выключена' });
    return false;
  }
  const attempts = row.attempts + 1;
  try {
    const thread = await loadSenderThread(db, row.reply_id, row.recipient_id);
    if (!thread) {
      await markRow(db, row.reply_id, { status: 'skipped', attempts, last_error: 'ответ или переписка не найдены' });
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
        // кампании в базе Instantly. Контекст оффера — наши собственные письма.
        briefText: '',
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
    await setRecipientVerdict(db, row.recipient_id, verdict.isLead);
    return verdict.isLead;
  } catch (err) {
    const message = errorText(err);
    const final = attempts >= MAX_ATTEMPTS;
    log(final ? 'error' : 'warn', `Оценка ответа ${row.reply_id} не удалась (попытка ${attempts}): ${message}`);
    await markRow(db, row.reply_id, {
      status: final ? 'error' : 'pending',
      attempts,
      next_attempt_at: final ? null : retryAt(attempts),
      last_error: message,
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
    if (!campaign.settings.telegram) { await skip('отправка в чат выключена у папки'); continue; }

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
      await markRow(db, row.reply_id, { tg_sent_at: new Date().toISOString(), tg_message_id: messageId, tg_error: null });
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
}

export async function runSenderLeadsPass(db: SupabaseClient, log: Log): Promise<PassResult> {
  const ai = senderLeadsAi();
  const result: PassResult = { qualified: 0, leads: 0, delivered: 0 };

  if (ai) {
    const fresh = await claimNew(db);
    const retries = await dueRetries(db, new Set(fresh.map((r) => r.reply_id)));
    const rows = [...fresh, ...retries];
    if (rows.length) {
      const settings = await loadCampaignSettings(db, rows.map((r) => r.campaign_id));
      for (const row of rows) {
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
  }

  const tg = leadTelegramConfig();
  if (tg) result.delivered = await deliverLeads(db, tg, log);
  return result;
}
