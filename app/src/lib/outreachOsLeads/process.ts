import type { SupabaseClient } from '@supabase/supabase-js';
import type { AmoClient } from '@/lib/crm/amoClient';
import {
  POLZA_CAMPAIGN_FIELD_ID,
  POLZA_CONNECTION,
  POLZA_SITE_FIELD_ID,
  POLZA_SOURCE_FIELD_ID,
  POLZA_SUBSOURCE_FIELD_ID,
} from '@/lib/crm/connections';
import { processCrmQueue, type CrmDealSpec, type CrmQueueRow } from '@/lib/crm/dealQueue';
import { corporateDomain } from '@/lib/ownReplyLeads/card';
import type { Log } from '@/lib/senderLeads/process';
import { clip, escapeHtml, leadTelegramConfig, sendLeadMessage, stripQuoted, type LeadTelegramConfig } from '@/lib/senderLeads/telegram';

/**
 * Заявки OutreachOS → сделка в нашей AMO → сообщение в General «Продажи Polza»
 * (решение пользователя 16.10.2026; таблица outreachos_lead_pushes).
 *
 * Кабинет OutreachOS — клиентский кабинет портала (outreachos@test.ru), из
 * которого менеджер разбирает заявки. Его боты (ответы кампаний, регистрации)
 * работают как раньше; здесь — копия в общий чат продаж тем же ботом, что и
 * автоаутрич, и сделка в AMO, ссылка на которую идёт в том же сообщении.
 *
 * Ставят в очередь квалификатор Instantly (ответ, признанный лидом) и маршруты
 * /api/signup и /api/demo-lead; разбирает воркер sender-leads.
 */

/** Клиент портала «OutreachOS» (profiles.email = outreachos@test.ru). */
export const OUTREACHOS_CLIENT_USER_ID = '1a64fcda-e477-46fb-983b-a2648b89881d';

// Как такие сделки заводили руками (зеркало amo_leads, июль–сентябрь 2026).
const PIPELINE_ID = 7670334; // «Воронка - новые лиды»
const STATUS_ID = 63385358; // «Новый лид»
const RESPONSIBLE_USER_ID = 10539886; // Юлия Миронова
const SOURCE_VALUE = 'Автоаутрич';
const SUB_SOURCE = 'OutreachOS';
const TAG = 'портал';

const MAX_TG_ATTEMPTS = 5;
const TG_BATCH = 20;
const TG_RETRY_MIN = [1, 5, 15, 60];
const REPLY_PREVIEW_MAX = 1200;

type Kind = 'reply' | 'registration';

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** Telegram HTML → текст примечания AMO: ссылки «подпись: адрес», без тегов. */
function htmlToNote(html: string): string {
  return html
    .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, (_m, url: string, label: string) => `${label}: ${url}`)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

async function enqueue(db: SupabaseClient, row: {
  kind: Kind;
  dedupeKey: string;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  campaignName: string;
  tgHtml: string;
}): Promise<void> {
  const email = row.leadEmail.trim().toLowerCase();
  const { error } = await db.from('outreachos_lead_pushes').insert({
    kind: row.kind,
    dedupe_key: row.dedupeKey.slice(0, 600),
    connection: POLZA_CONNECTION,
    pipeline_id: PIPELINE_ID,
    status_id: STATUS_ID,
    lead_email: email,
    lead_name: row.leadName,
    company_name: row.companyName,
    website: corporateDomain(email),
    campaign_name: row.campaignName,
    tg_html: row.tgHtml,
    message_text: htmlToNote(row.tgHtml),
  });
  // Та же заявка уже в очереди — второй сделки и второго сообщения не будет.
  if (error && error.code !== '23505') throw new Error(`outreachos_lead_pushes insert: ${error.message}`);
}

export interface OutreachOsReplyLead {
  qualificationId: string;
  campaignName: string | null;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  replySubject: string | null;
  replyBody: string | null;
}

export function buildOutreachOsReplyMessage(lead: OutreachOsReplyLead): string {
  const lines = ['📨 <b>Новый лид OutreachOS</b>', ''];
  if (lead.campaignName) lines.push(`<b>Кампания:</b> ${escapeHtml(clip(lead.campaignName, 200))}`);
  const contact = lead.leadName ? `${lead.leadName} · ${lead.leadEmail}` : lead.leadEmail;
  lines.push(`<b>Контакт:</b> ${escapeHtml(clip(contact, 320))}`);
  if (lead.companyName) lines.push(`<b>Компания:</b> ${escapeHtml(clip(lead.companyName, 200))}`);
  if (lead.replySubject) lines.push(`<b>Тема:</b> ${escapeHtml(clip(lead.replySubject, 300))}`);
  const body = lead.replyBody ? stripQuoted(lead.replyBody) || lead.replyBody.trim() : '';
  if (body) lines.push('', '<b>Ответ:</b>', `<pre>${escapeHtml(clip(body, REPLY_PREVIEW_MAX))}</pre>`);
  return lines.join('\n');
}

/** Ответ кампании кабинета OutreachOS, признанный лидом. */
export async function enqueueOutreachOsReplyLead(db: SupabaseClient, lead: OutreachOsReplyLead): Promise<void> {
  await enqueue(db, {
    kind: 'reply',
    dedupeKey: `reply:${lead.qualificationId}`,
    leadEmail: lead.leadEmail,
    leadName: lead.leadName,
    companyName: lead.companyName,
    campaignName: lead.campaignName ?? '',
    tgHtml: buildOutreachOsReplyMessage(lead),
  });
}

/**
 * Регистрация или заявка с лендинга: tgHtml — то же сообщение, что ушло в бота
 * регистраций. Ключ — почта и вид заявки за сутки МСК: двойной клик по форме
 * второй сделки не заводит, новая заявка на следующий день — заводит.
 */
export async function enqueueOutreachOsRegistration(db: SupabaseClient, input: {
  source: string;
  email: string;
  name: string | null;
  company: string | null;
  tgHtml: string;
}): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!email) return;
  const day = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  await enqueue(db, {
    kind: 'registration',
    dedupeKey: `registration:${input.source}:${email}:${day}`,
    leadEmail: email,
    leadName: input.name,
    companyName: input.company,
    campaignName: input.source === 'register' ? 'Регистрация' : 'Заявка с лендинга',
    tgHtml: input.tgHtml,
  });
}

// ── AMO ─────────────────────────────────────────────────────────────────────

interface PushRow extends CrmQueueRow {
  kind: Kind;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  website: string | null;
  campaign_name: string;
}

const PUSH_EXTRA_COLUMNS = 'kind, lead_email, lead_name, company_name, website, campaign_name';

/** Открытая сделка человека по почте контакта: туда примечание, новую не заводим. */
async function findOpenLead(client: AmoClient, email: string): Promise<{ id: number; name: string } | null> {
  const contactId = await client.findContact({ name: email, email });
  return contactId ? client.findOpenLeadOfContact(contactId) : null;
}

function toDeal(row: PushRow): CrmDealSpec {
  const what = row.kind === 'reply' ? SUB_SOURCE : `${SUB_SOURCE} · ${row.campaign_name}`;
  const leadName = `${row.company_name || row.lead_email} · ${what}`.slice(0, 250);
  return {
    contact: { name: row.lead_name || row.lead_email, email: row.lead_email },
    leadName,
    tags: [TAG],
    polzaSelects: [{ fieldId: POLZA_SOURCE_FIELD_ID, fieldName: 'Источник', value: SOURCE_VALUE }],
    polzaTexts: [
      { fieldId: POLZA_SUBSOURCE_FIELD_ID, value: SUB_SOURCE },
      { fieldId: POLZA_CAMPAIGN_FIELD_ID, value: row.campaign_name },
      { fieldId: POLZA_SITE_FIELD_ID, value: row.website ?? '' },
    ],
    responsibleUserId: RESPONSIBLE_USER_ID,
    findExistingLead: (client) => findOpenLead(client, row.lead_email),
    existingLeadPatch: (lead) => ({ action: 'note_added', amo_lead_name: lead.name }),
    createdLeadPatch: { action: 'created', amo_lead_name: leadName },
    label: `OutreachOS · ${row.lead_email}`,
  };
}

// ── Чат ─────────────────────────────────────────────────────────────────────

function dealLine(row: { status: string; action: string | null; lead_url: string | null; amo_lead_name: string | null; error_message: string | null }): string {
  if (row.status === 'failed' || !row.lead_url) {
    return `⚠️ <b>Сделка в AMO не создана:</b> ${escapeHtml(clip(row.error_message ?? 'неизвестная ошибка', 300))}`;
  }
  const link = `<a href="${escapeHtml(row.lead_url)}">${escapeHtml(clip(row.amo_lead_name || 'Открыть сделку', 200))}</a>`;
  return row.action === 'note_added' ? `🔁 <b>Добавлено в открытую сделку:</b> ${link}` : `🔗 <b>Сделка в amoCRM:</b> ${link}`;
}

async function deliverMessages(db: SupabaseClient, tg: LeadTelegramConfig, log: Log): Promise<number> {
  const { data, error } = await db
    .from('outreachos_lead_pushes')
    .select('id, kind, status, action, lead_url, amo_lead_name, error_message, tg_html, tg_attempts, lead_email, next_attempt_at')
    .in('status', ['sent', 'failed'])
    .is('tg_sent_at', null)
    .lt('tg_attempts', MAX_TG_ATTEMPTS)
    .order('created_at')
    .limit(TG_BATCH);
  if (error) throw new Error(`outreachos_lead_pushes tg: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string; kind: Kind; status: string; action: string | null; lead_url: string | null; amo_lead_name: string | null;
    error_message: string | null; tg_html: string; tg_attempts: number; lead_email: string; next_attempt_at: string;
  }>;

  let sent = 0;
  for (const row of rows) {
    // После сбоя чата — пауза по лесенке; next_attempt_at ставит неудачная попытка.
    if (row.tg_attempts > 0 && Date.parse(row.next_attempt_at) > Date.now()) continue;
    let messageId: number;
    try {
      // CRM persists action before adding the note, so retries keep the same
      // meaning. Relabel only the General copy; registration and CRM notes stay intact.
      const body = row.kind === 'reply' && row.action === 'note_added'
        ? row.tg_html.replace(/^📨 <b>Новый лид OutreachOS<\/b>/u,
          '📨 <b>Новый ответ существующего лида OutreachOS</b>')
        : row.tg_html;
      messageId = await sendLeadMessage(tg, `${body}\n\n${dealLine(row)}`);
    } catch (err) {
      const attempts = row.tg_attempts + 1;
      const minutes = TG_RETRY_MIN[Math.min(attempts - 1, TG_RETRY_MIN.length - 1)];
      log('warn', `OutreachOS: сообщение по ${row.lead_email} не ушло в чат (попытка ${attempts}): ${errorText(err)}`);
      await db.from('outreachos_lead_pushes').update({
        tg_attempts: attempts, tg_error: errorText(err),
        next_attempt_at: new Date(Date.now() + minutes * 60_000).toISOString(),
      }).eq('id', row.id);
      continue;
    }
    sent += 1;
    // Сообщение уже в чате: сбой отметки не считаем сбоем отправки.
    const mark = { tg_sent_at: new Date().toISOString(), tg_message_id: messageId, tg_error: null };
    let marked = await db.from('outreachos_lead_pushes').update(mark).eq('id', row.id);
    if (marked.error) marked = await db.from('outreachos_lead_pushes').update(mark).eq('id', row.id);
    if (marked.error) log('error', `OutreachOS: сообщение по ${row.lead_email} ушло, но отметка не записалась (${marked.error.message}) — возможен дубль в чате`);
  }
  return sent;
}

export interface OutreachOsPassResult {
  pushed: number;
  delivered: number;
}

/** Один круг: сделки в AMO, затем сообщения в General со ссылкой на сделку. */
export async function runOutreachOsLeadsPass(db: SupabaseClient, log: Log): Promise<OutreachOsPassResult> {
  const pushed = await processCrmQueue<PushRow>(db, {
    table: 'outreachos_lead_pushes',
    extraColumns: PUSH_EXTRA_COLUMNS,
    toDeal,
    log: (level, msg) => log(level === 'warning' ? 'warn' : level, msg),
  });
  const tg = leadTelegramConfig();
  const delivered = tg ? await deliverMessages(db, tg, log) : 0;
  return { pushed, delivered };
}
