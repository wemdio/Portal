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
    qualificationStatus: null,
  };
}

/** Страниц на кампанию за один запрос списка — чтобы «Показать ещё» не выжирал лимит /emails. */
const MAX_PAGES_PER_CAMPAIGN = 5;

/**
 * Первые `limit` ответов по кампаниям живого аккаунта, свежие сверху.
 * `hasMore` — у какой-то кампании остались непрочитанные страницы.
 */
export async function listLiveReplies(params: {
  campaignIds: string[];
  accountId: string;
  limit: number;
  search?: string;
}): Promise<{ rows: QualificationRow[]; hasMore: boolean }> {
  if (!params.campaignIds.length) return { rows: [], hasMore: false };
  const results: QualificationRow[] = [];
  let hasMore = false;
  const search = params.search?.trim() || undefined;
  for (const campaignId of params.campaignIds) {
    try {
      let cursor: string | undefined;
      let fetched = 0;
      for (let page = 0; page < MAX_PAGES_PER_CAMPAIGN; page += 1) {
        const response = await listEmails(
          {
            campaign_id: campaignId,
            email_type: 'received',
            sort_order: 'desc',
            limit: 100,
            search,
            starting_after: cursor,
          },
          { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'fresh', consumer: 'personalization_feed' },
        );
        for (const email of response.items ?? []) {
          if (!email.id || !email.lead) continue;
          results.push(toQualificationRow({ ...email, lead: email.lead }, campaignId));
        }
        fetched += response.items?.length ?? 0;
        cursor = response.next_starting_after;
        if (!cursor || !response.items?.length) break;
        if (fetched >= params.limit) {
          hasMore = true;
          break;
        }
      }
      if (cursor && fetched < params.limit) hasMore = true;
    } catch {
      // Одна недоступная кампания не должна ронять список остальных.
    }
  }
  const sorted = results.sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''));
  return { rows: sorted.slice(0, params.limit), hasMore: hasMore || sorted.length > params.limit };
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
