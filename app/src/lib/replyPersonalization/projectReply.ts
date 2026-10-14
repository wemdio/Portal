import {
  countInboxByCampaign,
  countSyncedQualificationsByCampaign,
  findQualificationIdsByEmailIds,
  getRecentlyLinkedCampaignIds,
  getCampaignAccountIds,
  getCampaignCatalog,
  getInboxReplyById,
  getProjectCampaignIds,
  getQualificationById,
  inboxHistoryPending,
  listInboxReplies,
  listSyncedQualifications,
} from './db';
import { getLiveReply, listLiveReplies } from './liveReplyList';
import { getProjectMailboxes, type ProjectMailboxes } from './projectMailboxes';
import { isOwnAgencyCampaign } from '@/lib/instantly/ownAgencyCampaign';
import type { QualificationRow, ReplyCampaignOption } from './types';

/** Сколько писем отдаём за раз; прокрутка до конца списка просит следующую сотню. */
export const LIST_PAGE_SIZE = 100;
/** Потолок одного запроса, чтобы догрузка не превращалась в выгрузку всей базы. */
const LIST_MAX_LIMIT = 2000;

export interface ProjectRepliesPage {
  rows: QualificationRow[];
  /** Кампании проекта для фильтра — всегда все, независимо от выбранной. */
  campaigns: ReplyCampaignOption[];
  /** Писем по фильтру всего; null — точно не посчитать (есть кампании с живых аккаунтов). */
  total: number | null;
  hasMore: boolean;
  /** История кампаний ещё догружается в базу — часть старых писем пока не видна. */
  historyLoading: boolean;
}

/** За сколько дней привязка считается свежей: её история догружается в базу. */
const LINK_HISTORY_DAYS = 30;

/**
 * Ответы лидов по проекту — все, включая отказы. Кампании основного аккаунта
 * читаются только из базы: вердикты квалификатора и ящик ответов без вердикта
 * (наши «N. Polza_…» и история до привязки — lib/instantly/replyInbox.ts).
 * Кампании остальных аккаунтов — живым запросом к их Instantly: у них свой
 * лимит, и он не занят. `campaignId` сужает список до одной кампании проекта,
 * `search` ищет по почте (и компании) ответившего.
 */
export async function listProjectReplies(
  projectId: string,
  options: {
    campaignId?: string | null;
    search?: string;
    limit?: number;
    /**
     * Только те ответы, которым квалификатор поставил «лид». Вердикта нет у
     * писем с живых аккаунтов и у ящика без вердикта — под этим фильтром они
     * не показываются вовсе, иначе «лиды» смешивались бы с непроверенными письмами.
     */
    onlyLeads?: boolean;
  } = {},
): Promise<ProjectRepliesPage> {
  const onlyLeads = options.onlyLeads === true;
  const projectCampaignIds = await getProjectCampaignIds(projectId);
  const catalog = await getCampaignCatalog(projectCampaignIds);
  const accountOf = (id: string) => catalog.get(id)?.accountId ?? 'main';
  const mainIds = projectCampaignIds.filter((id) => accountOf(id) === 'main');
  const ownIds = mainIds.filter((id) => isOwnAgencyCampaign(catalog.get(id)?.name));
  const syncedIds = mainIds.filter((id) => !ownIds.includes(id));

  // Счётчики — по всем кампаниям проекта, независимо от выбранной: кнопки
  // кампаний над списком показывают, куда переключаться.
  const [qualCounts, inboxCounts, recentlyLinked] = await Promise.all([
    countSyncedQualificationsByCampaign(syncedIds, options.search, { onlyLeads }),
    onlyLeads ? Promise.resolve(new Map<string, number>()) : countInboxByCampaign(mainIds, options.search),
    getRecentlyLinkedCampaignIds(projectId, new Date(Date.now() - LINK_HISTORY_DAYS * 24 * 60 * 60_000).toISOString()),
  ]);
  const counts = new Map<string, number>();
  for (const id of mainIds) counts.set(id, (qualCounts.get(id) ?? 0) + (inboxCounts.get(id) ?? 0));

  // Сверху кампании, где больше ответов; без счётчика (живые аккаунты) — в конце.
  const campaigns: ReplyCampaignOption[] = projectCampaignIds
    .map((id) => ({
      id,
      name: catalog.get(id)?.name || `Кампания ${id.slice(0, 8)}`,
      replyCount: counts.get(id) ?? null,
    }))
    .sort((a, b) => (b.replyCount ?? -1) - (a.replyCount ?? -1) || a.name.localeCompare(b.name, 'ru'));

  // Чужую кампанию через фильтр не подсунуть: берём только кампании проекта.
  const campaignIds = options.campaignId
    ? projectCampaignIds.filter((id) => id === options.campaignId)
    : projectCampaignIds;
  const limit = Math.min(Math.max(options.limit ?? LIST_PAGE_SIZE, 1), LIST_MAX_LIMIT);

  const byAccount = new Map<string, string[]>();
  for (const id of campaignIds) {
    const account = accountOf(id);
    byAccount.set(account, [...(byAccount.get(account) ?? []), id]);
  }

  const parts = await Promise.all(
    [...byAccount].map(async ([accountId, ids]) => {
      if (accountId === 'main') {
        const [synced, inbox] = await Promise.all([
          listSyncedQualifications(ids.filter((id) => !ownIds.includes(id)), { limit, search: options.search, onlyLeads }),
          onlyLeads ? Promise.resolve({ rows: [] as QualificationRow[], total: 0 }) : listInboxReplies(ids, { limit, search: options.search }),
        ]);
        // Письмо истории, которое квалификатор потом всё-таки взял, — одна строка, с вердиктом.
        const taken = inbox.rows.length ? await findQualificationIdsByEmailIds(inbox.rows.map((row) => row.id)) : new Map();
        const extra = inbox.rows.filter((row) => !taken.has(row.id));
        return {
          rows: [...synced.rows, ...extra],
          total: (synced.total + inbox.total - taken.size) as number | null,
          hasMore: synced.total > synced.rows.length || inbox.total > inbox.rows.length,
        };
      }
      // У живого аккаунта квалификации нет — под фильтром «только лиды» такие
      // кампании молчат, а не подмешивают непроверенные письма.
      if (onlyLeads) return { rows: [] as QualificationRow[], total: 0 as number | null, hasMore: false };
      const { rows, hasMore } = await listLiveReplies({ campaignIds: ids, accountId, limit, search: options.search });
      return { rows, total: null as number | null, hasMore };
    }),
  );

  // Имя кампании в строке — из каталога: у живых писем и ящика его нет вовсе.
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  const merged = parts
    .flatMap((p) => p.rows)
    .map((row) => ({ ...row, campaignName: campaignNames.get(row.campaignId) ?? row.campaignName }))
    .sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''));

  const rows = merged.slice(0, limit);
  const total = parts.every((p) => p.total !== null)
    ? parts.reduce((sum, p) => sum + (p.total ?? 0), 0)
    : null;
  // История догружается фоном: пока она не дочитана, экран так и пишет.
  const historyIds = mainIds.filter((id) => ownIds.includes(id) || recentlyLinked.has(id));
  return {
    rows,
    campaigns,
    total,
    hasMore: merged.length > limit || parts.some((p) => p.hasMore),
    historyLoading: onlyLeads ? false : await inboxHistoryPending(historyIds),
  };
}

/** Письмо из списка проекта вместе с аккаунтом, через который его читать и на него отвечать. */
export async function resolveProjectReply(
  projectId: string,
  replyId: string,
): Promise<{ qualification: QualificationRow; accountId: string } | null> {
  const synced = await getQualificationById(replyId);
  if (synced) {
    const accounts = await getCampaignAccountIds([synced.campaignId]);
    return { qualification: synced, accountId: accounts.get(synced.campaignId) ?? 'main' };
  }

  const campaignIds = await getProjectCampaignIds(projectId);
  if (!campaignIds.length) return null;
  // Ящик без вердикта (наши «N. Polza_…», история до привязки) — из базы, без Instantly.
  const inbox = await getInboxReplyById(replyId);
  if (inbox && campaignIds.includes(inbox.row.campaignId)) {
    return { qualification: inbox.row, accountId: inbox.accountId };
  }
  const accounts = await getCampaignAccountIds(campaignIds);
  // Живое письмо — письмо кампании другого аккаунта (их квалификатор не
  // синкает) или письмо папки Others любого аккаунта проекта, включая основной.
  // Основной — последним: письма его кампаний уже нашлись в таблице выше.
  const accountIds = [...new Set(accounts.values())].sort((a, b) => Number(a === 'main') - Number(b === 'main'));
  let mailboxes: Promise<ProjectMailboxes> | null = null;
  return getLiveReply({
    emailId: replyId,
    accountIds,
    campaignIds,
    mailboxesFor: async (accountId) => {
      mailboxes ??= getProjectMailboxes(campaignIds, accounts);
      return (await mailboxes).byAccount.get(accountId);
    },
  });
}
