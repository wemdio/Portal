import type { SupabaseClient } from '@supabase/supabase-js';
import { getLeadsByEmail } from '@/lib/instantly/client';
import { readInstantlyEmailReadDeferral } from '@/lib/instantly/emailReadDeferral';
import { fetchThreadContext, qualifyReply, type ThreadContext } from '@/lib/instantly/leadQualifier';
import { isOwnAgencyCampaign } from '@/lib/instantly/ownAgencyCampaign';
import { isFreeProvider } from '@/lib/emailValidation/shared';
import {
  POLZA_CAMPAIGN_FIELD_ID,
  POLZA_CONNECTION,
  POLZA_CONTOUR_EMAIL_OUTREACH,
  POLZA_CONTOUR_FIELD_ID,
  POLZA_SITE_FIELD_ID,
  POLZA_SOURCE_EMAIL_OUTREACH,
  POLZA_SOURCE_FIELD_ID,
  POLZA_SUBSOURCE_FIELD_ID,
} from '@/lib/crm/connections';
import { AmoHttpError, type AmoClient } from '@/lib/crm/amoClient';
import { processCrmQueue, type CrmDealSpec, type CrmQueueRow } from '@/lib/crm/dealQueue';
import { senderLeadsAi, type Log, type SenderLeadsAi } from '@/lib/senderLeads/process';
import { leadTelegramConfig, sendLeadMessage, type LeadTelegramConfig } from '@/lib/senderLeads/telegram';
import {
  buildOwnReplyCard,
  buildOwnReplyTgMessage,
  corporateDomain,
  emailDomain,
  messagesFromContext,
  siteHost,
  subSourceOf,
} from './card';
import {
  OWN_REPLY_PIPELINE_ID,
  OWN_REPLY_RESPONSIBLE_USER_ID,
  OWN_REPLY_STATUS_ID,
  OWN_REPLY_TAG,
  criteriaForCampaign,
  loadOwnLeadCriteria,
  loadOwnReplySettings,
  saveInboxCursor,
  type OwnLeadCriteria,
  type OwnReplySettings,
} from './settings';

/**
 * Ответы наших email-кампаний («N. Polza_…», «ENagency …») → оценка ИИ → сделка
 * в нашей AMO → сообщение в «Продажи Polza»
 * (docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md).
 *
 * 1. Новые строки instantly_reply_inbox (база Instantly) наших кампаний —
 *    по курсору (created_at, email_id), только с ответом после включения.
 * 2. Переписку читаем из Instantly сами: отказ общего лимита или сбой чтения
 *    истории — не повод оценивать ответ без нашего письма; строка ждёт и
 *    попытку не тратит (лимит) либо тратит, но «не лидом» не становится.
 * 3. Лид → задача own_reply_crm_pushes; одна на человека (уникальный индекс).
 * 4. Общая очередь AMO: открытая сделка человека → примечание, иначе новая.
 * 5. После AMO — сообщение в ТГ; сбой ТГ не трогает AMO.
 */

const CLAIM_BATCH = 200;
const QUALIFY_BATCH = 10;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MIN = [1, 5, 15, 60];
const DEFERRAL_MIN_DELAY_MS = 2 * 60_000;
const DEFERRAL_MAX_DELAY_MS = 30 * 60_000;
const TG_BATCH = 20;
const CONSUMER = 'own_reply_leads';

export interface OwnReplyPassResult {
  claimed: number;
  qualified: number;
  leads: number;
  pushed: number;
  delivered: number;
}

interface InboxRow {
  email_id: string;
  campaign_id: string;
  thread_id: string | null;
  lead_email: string;
  subject: string | null;
  body_preview: string | null;
  reply_timestamp: string | null;
  created_at: string;
}

interface QualRow {
  email_id: string;
  campaign_id: string;
  campaign_name: string;
  lead_email: string;
  thread_id: string | null;
  reply_preview: string | null;
  attempts: number;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

function retryAt(attempts: number): string {
  const minutes = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Значение для or-фильтра PostgREST: в кавычках, иначе «:», «+», «.» ломают разбор. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Сайт из данных Instantly: бесплатный почтовый домен сайтом компании не считаем. */
function companySite(value: string | null | undefined): string | null {
  const host = siteHost(value);
  return host && !isFreeProvider(host) ? host : null;
}

/** Наши кампании основного аккаунта: id → название. Отбор — только через isOwnAgencyCampaign. */
async function ownCampaigns(instantlyDb: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await instantlyDb
    .from('instantly_campaign_catalog')
    .select('id, name, instantly_account_id')
    .or('name.ilike.%polza%,name.ilike.%enagency%');
  if (error) throw new Error(`instantly_campaign_catalog: ${error.message}`);
  const out = new Map<string, string>();
  for (const row of (data ?? []) as { id: string; name: string | null; instantly_account_id: string | null }[]) {
    if ((row.instantly_account_id || 'main') === 'main' && isOwnAgencyCampaign(row.name)) out.set(row.id, row.name ?? '');
  }
  return out;
}

/** Новые ответы из инбокса → строки оценки (pending). Курсор двигается всегда. */
async function claimFromInbox(db: SupabaseClient, instantlyDb: SupabaseClient, settings: OwnReplySettings): Promise<number> {
  if (!settings.enabledAt || !settings.cursorAt) return 0;
  const campaigns = await ownCampaigns(instantlyDb);
  if (!campaigns.size) return 0;

  // Пара (created_at, email_id): одна страница сборщика вставляется одним
  // запросом и получает одинаковый created_at — по одной дате курсор бы стоял.
  const { data, error } = await instantlyDb
    .from('instantly_reply_inbox')
    .select('email_id, campaign_id, thread_id, lead_email, subject, body_preview, reply_timestamp, created_at')
    .in('campaign_id', [...campaigns.keys()])
    .or(`created_at.gt.${quoted(settings.cursorAt)},and(created_at.eq.${quoted(settings.cursorAt)},email_id.gt.${quoted(settings.cursorId ?? '')})`)
    .order('created_at', { ascending: true })
    .order('email_id', { ascending: true })
    .limit(CLAIM_BATCH);
  if (error) throw new Error(`instantly_reply_inbox: ${error.message}`);
  const rows = (data ?? []) as InboxRow[];
  if (!rows.length) return 0;

  const enabledMs = Date.parse(settings.enabledAt);
  // Догрузка истории пишет старые ответы свежими строками — фильтр по времени ответа.
  const fresh = rows.filter((r) => r.reply_timestamp && Date.parse(r.reply_timestamp) >= enabledMs);
  if (fresh.length) {
    const nowIso = new Date().toISOString();
    const { error: insertError } = await db.from('own_reply_qualifications').upsert(
      fresh.map((r) => ({
        email_id: r.email_id,
        campaign_id: r.campaign_id,
        campaign_name: campaigns.get(r.campaign_id) ?? '',
        lead_email: r.lead_email.trim().toLowerCase(),
        thread_id: r.thread_id,
        reply_subject: r.subject,
        reply_preview: r.body_preview,
        reply_timestamp: r.reply_timestamp,
        status: 'pending',
        next_attempt_at: nowIso,
      })),
      { onConflict: 'email_id', ignoreDuplicates: true },
    );
    if (insertError) throw new Error(`own_reply_qualifications insert: ${insertError.message}`);
  }
  const last = rows[rows.length - 1];
  await saveInboxCursor(db, last.created_at, last.email_id);
  return fresh.length;
}

async function dueQualifications(db: SupabaseClient): Promise<QualRow[]> {
  const { data, error } = await db
    .from('own_reply_qualifications')
    .select('email_id, campaign_id, campaign_name, lead_email, thread_id, reply_preview, attempts')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at')
    .limit(QUALIFY_BATCH);
  if (error) throw new Error(`own_reply_qualifications due: ${error.message}`);
  return (data ?? []) as QualRow[];
}

async function markQual(db: SupabaseClient, emailId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('own_reply_qualifications')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('email_id', emailId);
  if (error) throw new Error(`own_reply_qualifications update: ${error.message}`);
}

/** Сбой оценки: строка остаётся pending и повторяется; «не лидом» она не становится. */
async function failAttempt(db: SupabaseClient, row: QualRow, attempts: number, message: string, log: Log): Promise<void> {
  const final = attempts >= MAX_ATTEMPTS;
  log(final ? 'error' : 'warn', `Наши кампании: ответ ${row.email_id} не оценён (попытка ${attempts}): ${message}`);
  await markQual(db, row.email_id, {
    status: final ? 'error' : 'pending',
    attempts,
    next_attempt_at: final ? new Date().toISOString() : retryAt(attempts),
    last_error: message,
  });
}

/** Instantly занят: ждём, попытку не считаем. */
async function deferRow(db: SupabaseClient, row: QualRow, retryAfterMs: number): Promise<void> {
  const delay = Math.min(DEFERRAL_MAX_DELAY_MS, Math.max(DEFERRAL_MIN_DELAY_MS, retryAfterMs));
  await markQual(db, row.email_id, {
    next_attempt_at: new Date(Date.now() + delay).toISOString(),
    last_error: 'Instantly занят — повторю',
  });
}

/** Данные лида из Instantly; не нашлось или ошибка — пусто, лид важнее. */
async function instantlyLead(row: QualRow) {
  try {
    const items = await getLeadsByEmail(
      { email: row.lead_email, campaign_id: row.campaign_id },
      { accountId: 'main', consumer: CONSUMER, requestPriority: 'bulk' },
    );
    return items.find((l) => (l.email ?? '').trim().toLowerCase() === row.lead_email) ?? null;
  } catch {
    return null;
  }
}

async function enqueuePush(db: SupabaseClient, row: QualRow, ctx: ThreadContext, log: Log): Promise<void> {
  const lead = await instantlyLead(row);
  const messages = messagesFromContext(ctx);
  const leadName = [lead?.first_name, lead?.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') || null;
  const companyName = (lead?.company_name ?? '').trim() || null;
  // Бесплатные почтовые домены (gmail, mail.ru…) сайтом компании не бывают.
  const website = companySite(lead?.website) ?? companySite(lead?.company_domain) ?? corporateDomain(row.lead_email);
  // Контакт в AMO — тот, кто написал ответ (не обязательно адрес рассылки): с него и ответим.
  const contactEmail = (ctx.replyEmail.from_address_email ?? '').trim().toLowerCase() || row.lead_email;
  const { error } = await db.from('own_reply_crm_pushes').insert({
    qualification_id: row.email_id,
    connection: POLZA_CONNECTION,
    pipeline_id: OWN_REPLY_PIPELINE_ID,
    status_id: OWN_REPLY_STATUS_ID,
    lead_email: contactEmail,
    lead_name: leadName,
    company_name: companyName,
    website,
    campaign_name: row.campaign_name,
    sub_source: subSourceOf(messages, row.reply_preview),
    message_text: buildOwnReplyCard({
      campaignName: row.campaign_name,
      leadEmail: contactEmail,
      leadName,
      companyName,
      phone: (lead?.phone ?? '').trim() || null,
      website,
      messages,
    }),
  });
  if (error?.code === '23505') {
    // Либо этот же ответ уже ставили (повтор после сбоя), либо человека
    // передали раньше — второй задачи и второго сообщения в чат не будет.
    const { data: own, error: ownError } = await db.from('own_reply_crm_pushes').select('id').eq('qualification_id', row.email_id).limit(1);
    // Не прочиталось — повтор позже, а не примечание «уже передавали» наугад.
    if (ownError) throw new Error(`own_reply_crm_pushes lookup: ${ownError.message}`);
    if (!own?.length) await markQual(db, row.email_id, { handoff_note: 'Этого человека уже передавали в AMO' });
    return;
  }
  if (error) throw new Error(`own_reply_crm_pushes insert: ${error.message}`);
  log('info', `Наши кампании: лид ${row.lead_email} поставлен в AMO`);
}

type QualOutcome = 'lead' | 'not_lead' | 'wait';

async function qualifyOne(
  db: SupabaseClient, row: QualRow, settings: OwnReplySettings, criteria: OwnLeadCriteria, ai: SenderLeadsAi, log: Log,
): Promise<QualOutcome> {
  const attempts = row.attempts + 1;
  try {
    // Задача в AMO уже стоит (вставка прошла, отметка «лид» — нет): ИИ заново не
    // спрашиваем, иначе «не лид» разошёлся бы с уже идущей сделкой.
    const { data: pushed, error: pushedError } = await db
      .from('own_reply_crm_pushes')
      .select('id')
      .eq('qualification_id', row.email_id)
      .limit(1);
    if (pushedError) throw new Error(`own_reply_crm_pushes lookup: ${pushedError.message}`);
    if (pushed?.length) {
      await markQual(db, row.email_id, { status: 'lead', attempts, last_error: null, qualified_at: new Date().toISOString() });
      return 'lead';
    }
    let ctx: ThreadContext | null;
    try {
      ctx = await fetchThreadContext(row.campaign_id, row.lead_email, row.thread_id, 'main', {
        consumer: CONSUMER,
        requestPriority: 'bulk',
      });
    } catch (err) {
      const deferral = readInstantlyEmailReadDeferral(err);
      if (!deferral) throw err;
      await deferRow(db, row, deferral.retryAfterMs);
      return 'wait';
    }
    if (!ctx) {
      await failAttempt(db, row, attempts, 'переписка не нашлась в Instantly', log);
      return 'wait';
    }
    // Без нашего письма ИИ легко назовёт интерес «не лидом» — не оцениваем вслепую.
    if (ctx.historyFetchFailed) {
      // Отказ общего лимита внутри чтения истории — тоже «Instantly занят», не попытка.
      const deferral = readInstantlyEmailReadDeferral(ctx.historyFetchFailureReason);
      if (deferral) {
        await deferRow(db, row, deferral.retryAfterMs);
        return 'wait';
      }
      await failAttempt(db, row, attempts, `переписка не прочиталась${ctx.historyFetchFailureReason ? `: ${ctx.historyFetchFailureReason}` : ''}`, log);
      return 'wait';
    }
    const leadCriteria = criteriaForCampaign(criteria, row.campaign_name);
    const verdict = await qualifyReply(row.campaign_id, row.lead_email, row.thread_id, {
      apiKey: ai.apiKey,
      ...(ai.model ? { model: ai.model } : {}),
      // Пустая строка, а не null: при null квалификатор искал бы бриф кампании.
      briefText: '',
      leadCriteria,
      prefetchedContext: ctx,
      maxRetries: 1,
    }, 'main');
    // Сначала задача в AMO, потом отметка «лид»: упадёт вставка — строка
    // останется pending и повторится, а лид не потеряется.
    if (verdict.isLead) await enqueuePush(db, row, ctx, log);
    await markQual(db, row.email_id, {
      status: verdict.isLead ? 'lead' : 'not_lead',
      ai_reason: verdict.reason?.slice(0, 2000) ?? null,
      interest_signals: verdict.interestSignals ?? [],
      criteria_used: Boolean(leadCriteria),
      model: ai.model ?? 'default',
      attempts,
      last_error: null,
      qualified_at: new Date().toISOString(),
    });
    return verdict.isLead ? 'lead' : 'not_lead';
  } catch (err) {
    const deferral = readInstantlyEmailReadDeferral(err);
    if (deferral) {
      await deferRow(db, row, deferral.retryAfterMs);
      return 'wait';
    }
    await failAttempt(db, row, attempts, errorText(err), log);
    return 'wait';
  }
}

// ── AMO ─────────────────────────────────────────────────────────────────────

interface PushRow extends CrmQueueRow {
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  website: string | null;
  campaign_name: string;
  sub_source: string;
}

const PUSH_EXTRA_COLUMNS = 'lead_email, lead_name, company_name, website, campaign_name, sub_source';

/**
 * Открытая сделка человека: сначала контакт с этой почтой в живой AMO, потом —
 * для корпоративной почты — сделка компании по домену в зеркале amo_leads.
 * Бесплатные домены в поиске по домену не участвуют.
 */
async function findOpenLead(db: SupabaseClient, client: AmoClient, email: string): Promise<{ id: number; name: string } | null> {
  const contactId = await client.findContact({ name: email, email });
  if (contactId) {
    const lead = await client.findOpenLeadOfContact(contactId);
    if (lead) return lead;
  }
  const domain = corporateDomain(email);
  if (!domain) return null;
  const { data, error } = await db
    .from('amo_leads')
    .select('amo_id, name, contact_email, company_website, status_id')
    .not('status_id', 'in', '(142,143)')
    .or(`contact_email.ilike.${quoted(`*@${domain}`)},company_website.ilike.${quoted(`*${domain}*`)}`)
    .order('updated_at', { ascending: false })
    .limit(20);
  // Сбой базы — временный: очередь AMO повторит задачу, а не закроет её навсегда.
  if (error) throw new AmoHttpError(`amo_leads: ${error.message}`, 503);
  const hit = ((data ?? []) as { amo_id: number; name: string | null; contact_email: string | null; company_website: string | null }[])
    .find((l) => emailDomain(l.contact_email) === domain || siteHost(l.company_website) === domain);
  return hit ? { id: Number(hit.amo_id), name: (hit.name ?? '').trim() || `Сделка #${hit.amo_id}` } : null;
}

function toDeal(db: SupabaseClient, row: PushRow): CrmDealSpec {
  const leadName = `${row.company_name || row.lead_email} · ${row.campaign_name}`.slice(0, 250);
  return {
    contact: { name: row.lead_name || row.lead_email, email: row.lead_email },
    leadName,
    tags: [OWN_REPLY_TAG],
    polzaSelects: [
      { fieldId: POLZA_SOURCE_FIELD_ID, fieldName: 'Источник', value: POLZA_SOURCE_EMAIL_OUTREACH },
      { fieldId: POLZA_CONTOUR_FIELD_ID, fieldName: 'Контур', value: POLZA_CONTOUR_EMAIL_OUTREACH },
    ],
    polzaTexts: [
      { fieldId: POLZA_SUBSOURCE_FIELD_ID, value: row.sub_source },
      { fieldId: POLZA_CAMPAIGN_FIELD_ID, value: row.campaign_name },
      { fieldId: POLZA_SITE_FIELD_ID, value: row.website ?? '' },
    ],
    responsibleUserId: OWN_REPLY_RESPONSIBLE_USER_ID,
    findExistingLead: (client) => findOpenLead(db, client, row.lead_email),
    existingLeadPatch: (lead) => ({ action: 'note_added', amo_lead_name: lead.name }),
    createdLeadPatch: { action: 'created', amo_lead_name: leadName },
    label: `${row.lead_email} · ${row.campaign_name}`,
  };
}

async function processPushes(db: SupabaseClient, log: Log): Promise<number> {
  return processCrmQueue<PushRow>(db, {
    table: 'own_reply_crm_pushes',
    extraColumns: PUSH_EXTRA_COLUMNS,
    toDeal: (row) => toDeal(db, row),
    log: (level, msg) => log(level === 'warning' ? 'warn' : level, msg),
  });
}

// ── Чат ─────────────────────────────────────────────────────────────────────

async function deliverMessages(db: SupabaseClient, tg: LeadTelegramConfig, log: Log): Promise<number> {
  const { data, error } = await db
    .from('own_reply_crm_pushes')
    .select('id, qualification_id, action, lead_url, amo_lead_name, lead_email, lead_name, company_name, campaign_name, tg_attempts')
    .eq('status', 'sent')
    .is('tg_sent_at', null)
    .lt('tg_attempts', MAX_ATTEMPTS)
    // next_attempt_at после AMO — остаток аренды задачи; ждать по нему стоит только после сбоя чата.
    .or(`tg_error.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
    .order('sent_at')
    .limit(TG_BATCH);
  if (error) throw new Error(`own_reply_crm_pushes tg: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string; qualification_id: string; action: 'created' | 'note_added' | null; lead_url: string | null;
    amo_lead_name: string | null; lead_email: string; lead_name: string | null; company_name: string | null;
    campaign_name: string; tg_attempts: number;
  }>;
  if (!rows.length) return 0;

  const { data: quals, error: qualError } = await db
    .from('own_reply_qualifications')
    .select('email_id, reply_subject, reply_preview, ai_reason')
    .in('email_id', rows.map((r) => r.qualification_id));
  if (qualError) throw new Error(`own_reply_qualifications tg: ${qualError.message}`);
  const byId = new Map(((quals ?? []) as { email_id: string; reply_subject: string | null; reply_preview: string | null; ai_reason: string | null }[])
    .map((q) => [q.email_id, q]));

  let sent = 0;
  for (const row of rows) {
    const q = byId.get(row.qualification_id);
    let messageId: number;
    try {
      messageId = await sendLeadMessage(tg, buildOwnReplyTgMessage({
        action: row.action ?? 'created',
        campaignName: row.campaign_name,
        leadEmail: row.lead_email,
        leadName: row.lead_name,
        companyName: row.company_name,
        replySubject: q?.reply_subject ?? null,
        replyBody: q?.reply_preview ?? null,
        aiReason: q?.ai_reason ?? null,
        leadUrl: row.lead_url,
        amoLeadName: row.amo_lead_name,
      }));
    } catch (err) {
      const attempts = row.tg_attempts + 1;
      log('warn', `Наши кампании: сообщение по ${row.lead_email} не ушло в чат (попытка ${attempts}): ${errorText(err)}`);
      await db.from('own_reply_crm_pushes').update({ tg_attempts: attempts, tg_error: errorText(err), next_attempt_at: retryAt(attempts) }).eq('id', row.id);
      continue;
    }
    sent += 1;
    // Сообщение уже в чате: сбой отметки не должен считаться сбоем отправки.
    const mark = { tg_sent_at: new Date().toISOString(), tg_message_id: messageId, tg_error: null };
    let marked = await db.from('own_reply_crm_pushes').update(mark).eq('id', row.id);
    if (marked.error) marked = await db.from('own_reply_crm_pushes').update(mark).eq('id', row.id);
    if (marked.error) log('error', `Наши кампании: сообщение по ${row.lead_email} ушло, но отметка не записалась (${marked.error.message}) — возможен дубль в чате`);
  }
  return sent;
}

// ── Проход ──────────────────────────────────────────────────────────────────

/**
 * Один круг. Выключенный блок не берёт новые ответы, но уже поставленные
 * лиды доводит до AMO и чата.
 */
export async function runOwnReplyLeadsPass(db: SupabaseClient, instantlyDb: SupabaseClient | null, log: Log): Promise<OwnReplyPassResult> {
  const result: OwnReplyPassResult = { claimed: 0, qualified: 0, leads: 0, pushed: 0, delivered: 0 };
  const settings = await loadOwnReplySettings(db);
  const ai = senderLeadsAi();
  if (settings.enabled && ai && instantlyDb) {
    // Сбой оценки не должен останавливать AMO и чат ниже.
    try {
      result.claimed = await claimFromInbox(db, instantlyDb, settings);
      const criteria = await loadOwnLeadCriteria(db);
      for (const row of await dueQualifications(db)) {
        let outcome: QualOutcome;
        try {
          outcome = await qualifyOne(db, row, settings, criteria, ai, log);
        } catch (err) {
          // Не записался статус строки — она повторится в следующем круге.
          log('error', `Наши кампании: ответ ${row.email_id} — сбой записи статуса: ${errorText(err)}`);
          continue;
        }
        if (outcome === 'wait') continue;
        result.qualified += 1;
        if (outcome === 'lead') result.leads += 1;
      }
    } catch (err) {
      log('error', `Наши кампании: сбор и оценка ответов — ${errorText(err)}`);
    }
  }
  result.pushed = await processPushes(db, log);
  const tg = leadTelegramConfig();
  if (tg) result.delivered = await deliverMessages(db, tg, log);
  return result;
}

// ── Холостой прогон ─────────────────────────────────────────────────────────

export interface DryRunRow {
  campaign: string;
  email: string;
  reply: string;
  verdict: 'lead' | 'not_lead' | 'error';
  reason: string;
}

/**
 * Последние ответы наших кампаний через квалификатор — без записи в базу,
 * без AMO и без чата. Для сверки с пользователем до включения.
 */
export async function dryRunOwnReplies(instantlyDb: SupabaseClient, criteria: OwnLeadCriteria, limit: number, log: Log): Promise<DryRunRow[]> {
  const ai = senderLeadsAi();
  if (!ai) throw new Error('SENDER_LEADS_AI_API_KEY не задан');
  const campaigns = await ownCampaigns(instantlyDb);
  if (!campaigns.size) return [];
  const { data, error } = await instantlyDb
    .from('instantly_reply_inbox')
    .select('email_id, campaign_id, thread_id, lead_email, body_preview, reply_timestamp')
    .in('campaign_id', [...campaigns.keys()])
    .order('reply_timestamp', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`instantly_reply_inbox: ${error.message}`);
  const out: DryRunRow[] = [];
  for (const r of (data ?? []) as InboxRow[]) {
    const base = { campaign: campaigns.get(r.campaign_id) ?? r.campaign_id, email: r.lead_email, reply: (r.body_preview ?? '').slice(0, 200).replace(/\s+/g, ' ') };
    try {
      const ctx = await fetchThreadContext(r.campaign_id, r.lead_email, r.thread_id, 'main', { consumer: CONSUMER, requestPriority: 'bulk' });
      if (!ctx || ctx.historyFetchFailed) { out.push({ ...base, verdict: 'error', reason: 'переписка не прочиталась' }); continue; }
      const v = await qualifyReply(r.campaign_id, r.lead_email, r.thread_id, {
        apiKey: ai.apiKey, ...(ai.model ? { model: ai.model } : {}), briefText: '', leadCriteria: criteriaForCampaign(criteria, campaigns.get(r.campaign_id)), prefetchedContext: ctx, maxRetries: 1,
      }, 'main');
      out.push({ ...base, verdict: v.isLead ? 'lead' : 'not_lead', reason: (v.reason ?? '').slice(0, 300) });
    } catch (err) {
      log('warn', `dry-run ${r.email_id}: ${errorText(err)}`);
      out.push({ ...base, verdict: 'error', reason: errorText(err) });
    }
  }
  return out;
}
