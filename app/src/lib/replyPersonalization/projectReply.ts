import { getCampaignAccountIds, getProjectCampaignIds, getQualificationById, listSyncedQualifications } from './db';
import { getLiveReply, listLiveReplies } from './liveReplyList';
import type { QualificationRow } from './types';

const LIST_LIMIT = 50;

/**
 * Ответы лидов по проекту. Кампании основного аккаунта читаются из таблицы
 * квалификатора, кампании остальных аккаунтов — живым запросом к их Instantly.
 */
export async function listProjectReplies(projectId: string): Promise<QualificationRow[]> {
  const campaignIds = await getProjectCampaignIds(projectId);
  const accounts = await getCampaignAccountIds(campaignIds);

  const byAccount = new Map<string, string[]>();
  for (const id of campaignIds) {
    const account = accounts.get(id) ?? 'main';
    byAccount.set(account, [...(byAccount.get(account) ?? []), id]);
  }

  const parts = await Promise.all(
    [...byAccount].map(([accountId, ids]) =>
      accountId === 'main' ? listSyncedQualifications(ids, LIST_LIMIT) : listLiveReplies({ campaignIds: ids, accountId }),
    ),
  );

  return parts
    .flat()
    .sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''))
    .slice(0, LIST_LIMIT);
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
