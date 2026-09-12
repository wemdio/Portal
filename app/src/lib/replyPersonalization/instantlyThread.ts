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

import { listEmails } from '@/lib/instantly/client';
import type { Email } from '@/lib/instantly/types';
import type { ThreadMessage } from './types';

function extractEmailText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  if (body.text) return body.text.trim();
  if (body.html) return body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
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
      { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'fresh' },
    );
    const messages: ThreadMessage[] = (response.items ?? [])
      .filter((email) => email.thread_id === params.threadId)
      .sort((a, b) => (a.timestamp_created ?? '').localeCompare(b.timestamp_created ?? ''))
      .map((email) => ({
        fromUs: email.ue_type === 1 || email.ue_type === 3,
        text: extractEmailText(email.body),
        timestamp: email.timestamp_created,
      }))
      .filter((message) => message.text.length > 0);
    return messages.length > 0 ? messages : null;
  } catch {
    // Сбой живого запроса не должен ронять генерацию — вызывающий код
    // откатывается на reply_body/last_outbound_preview из уже сохранённых
    // данных (см. generateDraft.ts).
    return null;
  }
}
