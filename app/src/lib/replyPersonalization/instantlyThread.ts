// Точечный, по клику «Сгенерировать», запрос полного треда письма к
// Instantly. Использует только тонкий примитив client.ts (listEmails) —
// НЕ импортирует leadQualifier.ts/leadQualificationWorker.ts. Сам вызов
// проходит через существующий общий бюджет /emails (emailReadBudget.ts),
// как и всё остальное в client.ts — отдельно реализовывать throttling
// не нужно.
//
// У Instantly нет надёжного фильтра по thread_id в /emails — поэтому тянем
// емейлы по campaign_id+search=leadEmail и фильтруем по thread_id на своей
// стороне. Это независимая реализация того же публичного API-нюанса, не
// импорт кода квалификатора.
//
// Письмо вне кампании (папка Others, «сироты» сторожа) фильтр по кампании не
// найдёт: Instantly его к ней не привязал. Для него берём всю переписку ящика
// с этим адресом.

import * as cheerio from 'cheerio';
import { listEmails } from '@/lib/instantly/client';
import {
  LEAD_DATE_FIRST_ATTRIBUTION,
  LEAD_DATED_ATTRIBUTION,
  LEAD_MONTH_FIRST_ATTRIBUTION,
  removeLeadReplyQuotes,
} from '@/lib/instantly/leadReplyHtml';
import type { Email } from '@/lib/instantly/types';
import { htmlToText } from './campaignSequence';
import type { QualificationRow, ThreadMessage } from './types';

/** Писем переписки ящика с адресом: последних хватает, прогрев бывает длинным. */
const MAILBOX_CONVERSATION_LIMIT = 50;

/**
 * Строка, с которой начинается процитированная история: «> …», «On … wrote:»
 * (у Gmail она бывает разорвана переносом до «wrote:»), «пт, 25 сент. … <a@b>:»,
 * «-----Original Message-----», «From: …».
 */
function isQuoteStart(line: string): boolean {
  const t = line.trim();
  return t.startsWith('>')
    || /^On\s.*\b\d{4}\b.*\d{1,2}:\d{2}/i.test(t)
    || /\bwrote:$/i.test(t)
    || /(?:написал|писал|пишет)(?:а|\(а\))?:$/i.test(t)
    || /\d{1,2}:\d{2}.*<[^<>\s]+@[^<>\s]+>:$/.test(t)
    || LEAD_DATED_ATTRIBUTION.test(t)
    || LEAD_DATE_FIRST_ATTRIBUTION.test(t)
    || LEAD_MONTH_FIRST_ATTRIBUTION.test(t)
    || /^-{2,}\s*(?:Original Message|Исходное сообщение|Пересылаемое сообщение)/i.test(t)
    || /^(?:From|От):\s/i.test(t);
}

/**
 * Письмо без цитаты прошлой переписки: каждое прошлое письмо и так стоит в
 * треде отдельным сообщением, а цитата превращала его в простыню из «>».
 * Письмо, целиком состоящее из цитаты, оставляем как есть — пустым не показываем.
 */
function cutQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cut = lines.findIndex(isQuoteStart);
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

/** Текстовая версия тоже приходит с &gt; вместо «>»; теги в ней не трогаем — «<a@b>» это адрес. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function extractEmailText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return cutQuotedHistory(decodeEntities(body));
  if (body.text) return cutQuotedHistory(decodeEntities(body.text));
  if (body.html) {
    // Цитаты-блоки (Gmail, Яндекс, Outlook) убираем по разметке, а не по тексту;
    // переносы строк и символы (&gt;, &lt;, &amp;) — как у письма в почте.
    // Переносы внутри исходника HTML — не переносы письма.
    const $ = cheerio.load(body.html);
    removeLeadReplyQuotes($);
    return cutQuotedHistory(htmlToText(($('body').html() ?? body.html).replace(/\s*\n\s*/g, ' ')));
  }
  return '';
}

function toThreadMessages(emails: Email[]): ThreadMessage[] {
  return [...emails]
    .sort((a, b) => (a.timestamp_created ?? '').localeCompare(b.timestamp_created ?? ''))
    .map((email) => ({
      fromUs: email.ue_type === 1 || email.ue_type === 3,
      text: extractEmailText(email.body),
      timestamp: email.timestamp_created,
    }))
    .filter((message) => message.text.length > 0);
}

export async function fetchFullThread(params: {
  campaignId: string;
  leadEmail: string;
  threadId: string;
  accountId: string;
}): Promise<ThreadMessage[] | null> {
  try {
    const response = await listEmails(
      {
        campaign_id: params.campaignId,
        search: params.leadEmail,
        mode: 'emode_all',
        sort_order: 'asc',
      },
      { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'interactive', consumer: 'personalization_thread' },
    );
    const messages = toThreadMessages((response.items ?? []).filter((email) => email.thread_id === params.threadId));
    return messages.length > 0 ? messages : null;
  } catch {
    // Сбой живого запроса не должен ронять генерацию — вызывающий код
    // откатывается на reply_body/last_outbound_preview из уже сохранённых
    // данных (см. generateDraft.ts).
    return null;
  }
}

async function fetchMailboxConversation(params: {
  mailbox: string;
  leadEmail: string;
  accountId: string;
}): Promise<ThreadMessage[] | null> {
  try {
    const response = await listEmails(
      {
        search: params.leadEmail,
        eaccount: params.mailbox,
        mode: 'emode_all',
        sort_order: 'desc',
        limit: MAILBOX_CONVERSATION_LIMIT,
      },
      { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'interactive', consumer: 'personalization_thread' },
    );
    const messages = toThreadMessages(response.items ?? []);
    return messages.length > 0 ? messages : null;
  } catch {
    return null;
  }
}

/**
 * Только буквы и цифры: копия письма из Instantly приходит из HTML, и знаки
 * препинания, кавычки и переносы в ней отличаются от того, что мы отправляли.
 */
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Дописывает в тред наши отправленные ответы, которых в нём ещё нет.
 *
 * Instantly показывает отправленное из портала письмо в треде с задержкой, а
 * бывает, что не показывает вовсе. Без этого ИИ не видел нашего ответа и
 * на просьбу о пинге заново отвечал на прошлую реплику адресата (07.10.2026),
 * а экран показывал диалог без ответа. Журнал отправок — наш, и он точно
 * знает, что ушло.
 *
 * Сверяем по началу текста: копия из Instantly содержит наш текст плюс
 * процитированную историю переписки, поэтому равенство строк не подходит.
 * Ставим по времени отправки — перед первым более поздним письмом треда.
 */
export function withSentDrafts(messages: ThreadMessage[], sent: { text: string; sentAt: string }[]): ThreadMessage[] {
  const result = [...messages];
  for (const draft of sent) {
    const key = normalize(draft.text).slice(0, 120);
    if (!key) continue;
    if (result.some((m) => m.fromUs && normalize(m.text).includes(key))) continue;
    const message: ThreadMessage = { fromUs: true, text: draft.text, timestamp: draft.sentAt || undefined };
    const sentAt = draft.sentAt ? Date.parse(draft.sentAt) : NaN;
    const later = Number.isNaN(sentAt)
      ? -1
      : result.findIndex((m) => m.timestamp !== undefined && Date.parse(m.timestamp) > sentAt);
    if (later === -1) result.push(message);
    else result.splice(later, 0, message);
  }
  return result;
}

/**
 * Переписка по письму из списка: письмо кампании — по треду, письмо вне
 * кампании — по ящику и адресу. null — получить не удалось, вызывающий код
 * откатывается на сохранённые отрывки.
 */
export async function fetchReplyThread(
  qualification: QualificationRow,
  accountId: string,
): Promise<ThreadMessage[] | null> {
  if (qualification.outOfCampaign && qualification.eaccount) {
    const messages = await fetchMailboxConversation({
      mailbox: qualification.eaccount,
      leadEmail: qualification.leadEmail,
      accountId,
    });
    // Сирота сторожа часто пишет с другого адреса: наших писем ему в выдаче
    // нет, а совпавшее исходящее сторож сохранил — показываем его первым.
    if (messages && !messages.some((m) => m.fromUs) && qualification.lastOutboundPreview) {
      return [{ fromUs: true, text: qualification.lastOutboundPreview }, ...messages];
    }
    return messages;
  }
  if (!qualification.threadId) return null;
  return fetchFullThread({
    campaignId: qualification.campaignId,
    leadEmail: qualification.leadEmail,
    threadId: qualification.threadId,
    accountId,
  });
}
