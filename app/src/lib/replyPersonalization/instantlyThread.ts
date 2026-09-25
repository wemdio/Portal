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

import { listEmails } from '@/lib/instantly/client';
import type { Email } from '@/lib/instantly/types';
import type { QualificationRow, ThreadMessage } from './types';

/** Писем переписки ящика с адресом: последних хватает, прогрев бывает длинным. */
const MAILBOX_CONVERSATION_LIMIT = 50;

function extractEmailText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  if (body.text) return body.text.trim();
  if (body.html) return body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
