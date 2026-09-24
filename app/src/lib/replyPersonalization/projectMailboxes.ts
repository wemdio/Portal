// Ящики кампаний проекта по аккаунтам Instantly — для папки Others.
//
// Письмо в Others к кампании не привязано, поэтому проект узнаём только по
// ящику, на который оно пришло. Ящики кампании Instantly задаёт списком
// (email_list) или тегами (email_tag_list); у большинства наших кампаний —
// тегами (см. app/scripts/instantly-dataset/005_fix_subject_view_and_mailboxes.sql).
// Тег раскрываем через GET /accounts?tag_ids, как launchClientProvisioning.
//
// /campaigns и /accounts — не LIST /emails, общий бюджет писем не трогают.
// Состав ящиков меняется редко: держим его в памяти полчаса.

import { getCampaign, listAccounts } from '@/lib/instantly/client';
import { InstantlyApiError } from '@/lib/instantly/errors';

const CACHE_TTL_MS = 30 * 60 * 1000;
/** Одновременных запросов к Instantly при сборе ящиков. */
const CONCURRENCY = 4;
/** Страниц /accounts на тег: 20 × 100 ящиков — заведомо больше любого тега. */
const MAX_TAG_PAGES = 20;

interface CampaignSenders {
  mailboxes: string[];
  tagIds: string[];
}

const campaignCache = new Map<string, { value: CampaignSenders; expiresAt: number }>();
const tagCache = new Map<string, { value: string[]; expiresAt: number }>();

function normalizeMailbox(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.includes('@') ? email : null;
}

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

async function getCampaignSenders(campaignId: string, accountId: string): Promise<CampaignSenders> {
  const key = `${accountId}:${campaignId}`;
  const cached = campaignCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value: CampaignSenders;
  try {
    const campaign = await getCampaign(campaignId, {
      accountId,
      timeoutMs: 15_000,
      consumer: 'personalization_mailboxes',
    });
    value = {
      mailboxes: (campaign.email_list ?? []).map(normalizeMailbox).filter((m): m is string => m !== null),
      tagIds: (campaign.email_tag_list ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0),
    };
  } catch (err) {
    // Кампанию удалили в Instantly — ящиков у неё нет, это не сбой.
    if (!(err instanceof InstantlyApiError && err.status === 404)) throw err;
    value = { mailboxes: [], tagIds: [] };
  }
  campaignCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function getTagMailboxes(tagId: string, accountId: string): Promise<string[]> {
  const key = `${accountId}:${tagId}`;
  const cached = tagCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const mailboxes: string[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_TAG_PAGES; page += 1) {
    const response = await listAccounts(
      { limit: 100, tag_ids: tagId, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { accountId, timeoutMs: 15_000, consumer: 'personalization_mailboxes' },
    );
    const items = response.items ?? [];
    for (const account of items) {
      const mailbox = normalizeMailbox(account?.email);
      if (mailbox) mailboxes.push(mailbox);
    }
    startingAfter = response.next_starting_after || undefined;
    if (!startingAfter || items.length === 0) break;
  }
  tagCache.set(key, { value: mailboxes, expiresAt: Date.now() + CACHE_TTL_MS });
  return mailboxes;
}

export interface ProjectMailboxes {
  /** Аккаунт Instantly → ящик → кампания проекта, с которой ящик работает. */
  byAccount: Map<string, Map<string, string>>;
  /** Кампании, ящики которых узнать не удалось (Instantly не ответил). */
  failedCampaignIds: string[];
}

/**
 * Ящики кампаний проекта. Ящик из нескольких кампаний проекта относим к первой
 * по порядку: её цепочку ИИ получит как контекст ответа.
 */
export async function getProjectMailboxes(
  campaignIds: string[],
  accountByCampaign: Map<string, string>,
): Promise<ProjectMailboxes> {
  const accountOf = (campaignId: string) => accountByCampaign.get(campaignId) ?? 'main';
  const failed = new Set<string>();
  const senders = new Map<string, CampaignSenders>();
  await forEachLimited(campaignIds, CONCURRENCY, async (campaignId) => {
    try {
      senders.set(campaignId, await getCampaignSenders(campaignId, accountOf(campaignId)));
    } catch {
      failed.add(campaignId);
    }
  });

  // Тег обычно общий у нескольких кампаний проекта — раскрываем его один раз.
  const tags = new Map<string, { accountId: string; tagId: string }>();
  for (const [campaignId, s] of senders) {
    for (const tagId of s.tagIds) tags.set(`${accountOf(campaignId)}:${tagId}`, { accountId: accountOf(campaignId), tagId });
  }
  const tagMailboxes = new Map<string, string[]>();
  await forEachLimited([...tags], CONCURRENCY, async ([key, { accountId, tagId }]) => {
    try {
      tagMailboxes.set(key, await getTagMailboxes(tagId, accountId));
    } catch {
      // Кампании с этим тегом попадут в failed ниже.
    }
  });

  const byAccount = new Map<string, Map<string, string>>();
  for (const campaignId of campaignIds) {
    const s = senders.get(campaignId);
    if (!s) continue;
    const accountId = accountOf(campaignId);
    const mailboxes = [...s.mailboxes];
    for (const tagId of s.tagIds) {
      const resolved = tagMailboxes.get(`${accountId}:${tagId}`);
      if (resolved) mailboxes.push(...resolved);
      else failed.add(campaignId);
    }
    const map = byAccount.get(accountId) ?? new Map<string, string>();
    for (const mailbox of mailboxes) if (!map.has(mailbox)) map.set(mailbox, campaignId);
    byAccount.set(accountId, map);
  }
  return { byAccount, failedCampaignIds: [...failed] };
}
