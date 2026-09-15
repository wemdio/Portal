// Живой список входящих ответов для Instantly-аккаунта, который квалификатор
// не синкает (не 'main') — см. «Отклонения от спеки» в плане реализации.
// Использует тот же примитив client.ts, что и instantlyThread.ts, поэтому
// проходит через тот же общий бюджет /emails, но уже отдельного, не 'main'
// воркспейса — на момент внедрения на нём нет других потребителей лимита.

import { getEmail, listEmails } from '@/lib/instantly/client';
import type { Email } from '@/lib/instantly/types';
import type { QualificationRow } from './types';

function extractPreview(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 500);
  if (body.text) return body.text.slice(0, 500);
  if (body.html) return body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return '';
}

/** id строки для письма с живого аккаунта — сам instantly_email_id. */
function toQualificationRow(email: Email & { lead: string }, campaignId: string): QualificationRow {
  return {
    id: email.id,
    campaignId,
    campaignName: null,
    leadEmail: email.lead,
    companyName: null,
    threadId: email.thread_id ?? null,
    replySubject: email.subject ?? null,
    replyBody: extractPreview(email.body),
    lastOutboundPreview: null,
    instantlyEmailId: email.id,
    eaccount: email.eaccount ?? null,
    replyTimestamp: email.timestamp_created ?? null,
  };
}

export async function listLiveReplies(params: {
  campaignIds: string[];
  accountId: string;
  limit?: number;
}): Promise<QualificationRow[]> {
  if (!params.campaignIds.length) return [];
  const results: QualificationRow[] = [];
  for (const campaignId of params.campaignIds) {
    try {
      const response = await listEmails(
        { campaign_id: campaignId, email_type: 'received', sort_order: 'desc' },
        { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'fresh', consumer: 'personalization_feed' },
      );
      for (const email of response.items ?? []) {
        if (!email.id || !email.lead) continue;
        results.push(toQualificationRow({ ...email, lead: email.lead }, campaignId));
      }
    } catch {
      // Одна недоступная кампания не должна ронять список остальных.
    }
  }
  return results
    .sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''))
    .slice(0, params.limit ?? 50);
}

/**
 * Одно письмо живого аккаунта по его id. Аккаунт письма заранее не известен,
 * поэтому пробуем аккаунты проекта по очереди; принимаем только письмо из
 * кампаний этого проекта.
 */
export async function getLiveReply(params: {
  emailId: string;
  accountIds: string[];
  campaignIds: string[];
}): Promise<{ qualification: QualificationRow; accountId: string } | null> {
  const allowed = new Set(params.campaignIds);
  for (const accountId of params.accountIds) {
    try {
      const email = await getEmail(params.emailId, { accountId, timeoutMs: 20_000, consumer: 'personalization_feed' });
      if (!email?.id || !email.lead || !email.campaign_id || !allowed.has(email.campaign_id)) continue;
      return { qualification: toQualificationRow({ ...email, lead: email.lead }, email.campaign_id), accountId };
    } catch {
      // Письма нет на этом аккаунте — пробуем следующий.
    }
  }
  return null;
}
