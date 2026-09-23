import {
  countSyncedQualificationsByCampaign,
  getCampaignAccountIds,
  getCampaignCatalog,
  getProjectCampaignIds,
  getQualificationById,
  listSyncedQualifications,
} from './db';
import { getLiveReply, listLiveReplies } from './liveReplyList';
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
}

/**
 * Ответы лидов по проекту — все, включая отказы. Кампании основного аккаунта
 * читаются из таблицы квалификатора, кампании остальных аккаунтов — живым
 * запросом к их Instantly. `campaignId` сужает список до одной кампании
 * проекта, `search` ищет по почте (и компании) ответившего.
 */
export async function listProjectReplies(
  projectId: string,
  options: { campaignId?: string | null; search?: string; limit?: number } = {},
): Promise<ProjectRepliesPage> {
  const projectCampaignIds = await getProjectCampaignIds(projectId);
  const catalog = await getCampaignCatalog(projectCampaignIds);

  // Счётчики — по всем кампаниям проекта, независимо от выбранной: кнопки
  // кампаний над списком показывают, куда переключаться.
  const syncedCampaignIds = projectCampaignIds.filter((id) => catalog.get(id)?.accountId === 'main');
  const counts = await countSyncedQualificationsByCampaign(syncedCampaignIds, options.search);

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
    const account = catalog.get(id)?.accountId ?? 'main';
    byAccount.set(account, [...(byAccount.get(account) ?? []), id]);
  }

  const parts = await Promise.all(
    [...byAccount].map(async ([accountId, ids]) => {
      if (accountId === 'main') {
        const { rows, total } = await listSyncedQualifications(ids, { limit, search: options.search });
        return { rows, total: total as number | null, hasMore: total > rows.length };
      }
      const { rows, hasMore } = await listLiveReplies({ campaignIds: ids, accountId, limit, search: options.search });
      return { rows, total: null, hasMore };
    }),
  );

  // Имя кампании в строке — из каталога: у живых писем его нет вовсе.
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  const merged = parts
    .flatMap((p) => p.rows)
    .map((row) => ({ ...row, campaignName: campaignNames.get(row.campaignId) ?? row.campaignName }))
    .sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''));

  const rows = merged.slice(0, limit);
  const total = parts.every((p) => p.total !== null)
    ? parts.reduce((sum, p) => sum + (p.total ?? 0), 0)
    : null;
  return {
    rows,
    campaigns,
    total,
    hasMore: merged.length > limit || parts.some((p) => p.hasMore),
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
  const accounts = await getCampaignAccountIds(campaignIds);
  const liveAccounts = [...new Set([...accounts.values()])].filter((a) => a !== 'main');
  if (!liveAccounts.length) return null;
  return getLiveReply({ emailId: replyId, accountIds: liveAccounts, campaignIds });
}
