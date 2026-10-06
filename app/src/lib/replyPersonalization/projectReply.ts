import {
  countSyncedQualificationsByCampaign,
  findQualificationIdsByEmailIds,
  getRecentlyLinkedCampaignIds,
  getCampaignAccountIds,
  getCampaignCatalog,
  getProjectCampaignIds,
  getQualificationById,
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
}

/** За сколько дней привязка считается свежей и её историю дочитываем из Instantly. */
const LINK_HISTORY_DAYS = 30;
/** Писем истории на запрос: кампании привязывают десятками ответов, не тысячами. */
const LINK_HISTORY_LIMIT = 300;
const LINK_HISTORY_TTL_MS = 60_000;
const linkHistoryCache = new Map<string, { rows: QualificationRow[]; expiresAt: number }>();

/**
 * Ответы, пришедшие до привязки кампании к проекту. Сборщик берёт только
 * привязанные кампании и письма не старше суток, поэтому кампания, которую
 * привязали позже (вручную или после правки названия), появлялась в проекте
 * пустой, хотя в Instantly на неё уже ответили. Читаем такие письма живьём —
 * без квалификации и уведомлений — и отдаём только те, которых в таблице нет.
 * Минутный кэш: список перечитывается после каждого ответа, а лимит чтения
 * писем Instantly общий на весь воркспейс.
 */
async function loadLinkHistory(
  projectId: string,
  mainCampaignIds: string[],
  search: string | undefined,
): Promise<QualificationRow[]> {
  if (!mainCampaignIds.length) return [];
  const since = new Date(Date.now() - LINK_HISTORY_DAYS * 24 * 60 * 60_000).toISOString();
  const recent = await getRecentlyLinkedCampaignIds(projectId, since);
  const campaignIds = mainCampaignIds.filter((id) => recent.has(id));
  if (!campaignIds.length) return [];

  const key = `${campaignIds.join(',')}|${search ?? ''}`;
  const cached = linkHistoryCache.get(key);
  let live = cached && cached.expiresAt > Date.now() ? cached.rows : null;
  if (!live) {
    live = (await listLiveReplies({ campaignIds, accountId: 'main', limit: LINK_HISTORY_LIMIT, search })).rows;
    // Пустой ответ не кэшируем: это может быть занятый Instantly, а не пустая кампания.
    if (live.length) linkHistoryCache.set(key, { rows: live, expiresAt: Date.now() + LINK_HISTORY_TTL_MS });
  }
  if (!live.length) return [];
  const synced = await findQualificationIdsByEmailIds(live.map((row) => row.id));
  return live.filter((row) => !synced.has(row.id));
}

const ownLiveCache = new Map<string, { rows: QualificationRow[]; hasMore: boolean; expiresAt: number }>();

/**
 * Наши кампании «N. Polza_…» основного аккаунта: квалификатор их не берёт
 * (см. lib/instantly/ownAgencyCampaign.ts), поэтому читаем живьём, как
 * кампании других аккаунтов. Минутный кэш — лимит чтения писем Instantly общий
 * на весь воркспейс, а список перечитывается после каждого ответа.
 */
async function listOwnAgencyLiveReplies(campaignIds: string[], limit: number, search: string | undefined) {
  const key = `${campaignIds.join(',')}|${limit}|${search ?? ''}`;
  const cached = ownLiveCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const result = await listLiveReplies({ campaignIds, accountId: 'main', limit, search });
  // Пустой ответ не кэшируем: это может быть занятый Instantly, а не пустая кампания.
  if (result.rows.length) ownLiveCache.set(key, { ...result, expiresAt: Date.now() + LINK_HISTORY_TTL_MS });
  return result;
}

/**
 * Ответы лидов по проекту — все, включая отказы. Кампании основного аккаунта
 * читаются из таблицы квалификатора, кампании остальных аккаунтов — живым
 * запросом к их Instantly. `campaignId` сужает список до одной кампании
 * проекта, `search` ищет по почте (и компании) ответившего.
 */
export async function listProjectReplies(
  projectId: string,
  options: {
    campaignId?: string | null;
    search?: string;
    limit?: number;
    /**
     * Только те ответы, которым квалификатор поставил «лид». Вердикта нет у
     * писем с живых аккаунтов и у истории недавно привязанных кампаний — под
     * этим фильтром они не показываются вовсе, иначе «лиды» смешивались бы с
     * непроверенными письмами.
     */
    onlyLeads?: boolean;
  } = {},
): Promise<ProjectRepliesPage> {
  const onlyLeads = options.onlyLeads === true;
  const projectCampaignIds = await getProjectCampaignIds(projectId);
  const catalog = await getCampaignCatalog(projectCampaignIds);

  // Счётчики — по всем кампаниям проекта, независимо от выбранной: кнопки
  // кампаний над списком показывают, куда переключаться.
  // Живьём читаются кампании других аккаунтов и наши «N. Polza_…» основного:
  // в таблице квалификатора их нет.
  const isLive = (id: string) =>
    (catalog.get(id)?.accountId ?? 'main') !== 'main' || isOwnAgencyCampaign(catalog.get(id)?.name);
  const syncedCampaignIds = projectCampaignIds.filter((id) => !isLive(id));
  const counts = await countSyncedQualificationsByCampaign(syncedCampaignIds, options.search, { onlyLeads });

  // История недавно привязанных кампаний: в таблице квалификатора её нет.
  const history = onlyLeads ? [] : await loadLinkHistory(projectId, syncedCampaignIds, options.search);
  for (const row of history) counts.set(row.campaignId, (counts.get(row.campaignId) ?? 0) + 1);

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
  const ownLiveIds: string[] = [];
  for (const id of campaignIds) {
    const account = catalog.get(id)?.accountId ?? 'main';
    if (account === 'main' && isLive(id)) {
      ownLiveIds.push(id);
      continue;
    }
    byAccount.set(account, [...(byAccount.get(account) ?? []), id]);
  }

  const parts = await Promise.all([
    // Наши «N. Polza_…»: вердикта нет — под «только лиды» молчат.
    (async () => {
      if (!ownLiveIds.length || onlyLeads) return { rows: [] as QualificationRow[], total: 0 as number | null, hasMore: false };
      const { rows, hasMore } = await listOwnAgencyLiveReplies(ownLiveIds, limit, options.search);
      return { rows, total: null as number | null, hasMore };
    })(),
    ...[...byAccount].map(async ([accountId, ids]) => {
      if (accountId === 'main') {
        const { rows, total } = await listSyncedQualifications(ids, { limit, search: options.search, onlyLeads });
        const extra = history.filter((row) => ids.includes(row.campaignId));
        return { rows: [...rows, ...extra], total: (total + extra.length) as number | null, hasMore: total > rows.length };
      }
      // У живого аккаунта квалификации нет — под фильтром «только лиды» такие
      // кампании молчат, а не подмешивают непроверенные письма.
      if (onlyLeads) return { rows: [], total: 0 as number | null, hasMore: false };
      const { rows, hasMore } = await listLiveReplies({ campaignIds: ids, accountId, limit, search: options.search });
      return { rows, total: null, hasMore };
    }),
  ]);

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
  if (!campaignIds.length) return null;
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
