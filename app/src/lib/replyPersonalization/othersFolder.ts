// Вкладка Others: папка Others в Instantly по ящикам кампаний проекта.
//
// Читаем живьём, когда специалист открывает вкладку, — как сам Unibox.
// Фоновой копии нет намеренно: она круглые сутки тратила бы общий лимит
// LIST /emails ради того, что открывают изредка (спецификация 2026-09-24).

import { listEmails } from '@/lib/instantly/client';
import { readInstantlyEmailReadDeferral } from '@/lib/instantly/emailReadDeferral';
import type { Email } from '@/lib/instantly/types';
import {
  findQualificationIdsByEmailIds,
  getCampaignAccountIds,
  getLatestDraftStatuses,
  getProjectCampaignIds,
} from './db';
import { othersLetterToRow } from './liveReplyList';
import { isRobotLetter, loadOurSendingDomains } from './othersFilter';
import { getProjectMailboxes } from './projectMailboxes';
import type { OthersPage, ReplyListItem } from './types';

const PAGE_SIZE = 100;
/** Ящиков в одном запросе: список уходит в строку запроса через запятую. */
const MAILBOXES_PER_LANE = 50;
const PAGE_CACHE_TTL_MS = 60_000;
const PAGE_CACHE_MAX = 200;

type OthersListPage = Omit<OthersPage, 'missingReason'>;

/** Один запрос LIST /emails: аккаунт и до 50 его ящиков, со своим курсором. */
interface Lane {
  key: string;
  accountId: string;
  mailboxes: string[];
}

/** Письма страницы из Instantly — без статусов: их считаем заново на каждый запрос. */
interface LettersPage {
  letters: { email: Email; campaignId: string }[];
  nextCursor: string | null;
  notices: string[];
}

const pageCache = new Map<string, { page: LettersPage; expiresAt: number }>();

function buildLanes(byAccount: Map<string, Map<string, string>>): Lane[] {
  const lanes: Lane[] = [];
  for (const [accountId, mailboxes] of byAccount) {
    // Сортировка — чтобы между страницами пачки ящиков не менялись местами.
    const sorted = [...mailboxes.keys()].sort();
    for (let i = 0; i < sorted.length; i += MAILBOXES_PER_LANE) {
      lanes.push({
        key: `${accountId}:${i / MAILBOXES_PER_LANE}`,
        accountId,
        mailboxes: sorted.slice(i, i + MAILBOXES_PER_LANE),
      });
    }
  }
  return lanes;
}

function encodeCursor(cursors: Record<string, string>): string | null {
  return Object.keys(cursors).length ? Buffer.from(JSON.stringify(cursors)).toString('base64url') : null;
}

function decodeCursor(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function cachePage(key: string, page: LettersPage) {
  const now = Date.now();
  for (const [cachedKey, entry] of pageCache) {
    if (entry.expiresAt <= now) pageCache.delete(cachedKey);
  }
  if (pageCache.size >= PAGE_CACHE_MAX) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(key, { page, expiresAt: now + PAGE_CACHE_TTL_MS });
}

/**
 * Страница папки Others по ящикам кампаний проекта, свежие сверху. cursor —
 * из прошлой страницы; search — полный адрес, его ищет сам Instantly; fresh —
 * мимо минутного кэша (кнопка «Обновить»).
 */
export async function listProjectOthers(
  projectId: string,
  options: { cursor?: string | null; search?: string; fresh?: boolean } = {},
): Promise<OthersListPage> {
  const search = options.search?.trim() || undefined;
  const cacheKey = `${projectId}|${search ?? ''}|${options.cursor ?? ''}`;
  const cached = options.fresh ? null : pageCache.get(cacheKey);
  const page = cached && cached.expiresAt > Date.now()
    ? cached.page
    : await fetchLetters(projectId, search, options.cursor ?? null, cacheKey);

  // Письмо, которое сторож Others уже перенёс в основной список, — та же
  // строка, с тем же черновиком и статусом.
  const qualificationIds = await findQualificationIdsByEmailIds(page.letters.map(({ email }) => email.id));
  const rows = page.letters.map(({ email, campaignId }) => {
    const row = othersLetterToRow(email, campaignId);
    return { ...row, id: qualificationIds.get(email.id) ?? row.id };
  });
  const statuses = await getLatestDraftStatuses(rows.map((row) => row.id));
  const seen = new Set<string>();
  const replies: ReplyListItem[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const status = statuses[row.id];
    replies.push({
      ...row,
      source: 'others',
      listStatus: status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'new',
    });
  }
  replies.sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''));
  return { replies, nextCursor: page.nextCursor, notices: page.notices };
}

async function fetchLetters(
  projectId: string,
  search: string | undefined,
  cursor: string | null,
  cacheKey: string,
): Promise<LettersPage> {
  const campaignIds = await getProjectCampaignIds(projectId);
  if (!campaignIds.length) {
    return { letters: [], nextCursor: null, notices: ['У проекта нет кампаний Instantly.'] };
  }
  const accountByCampaign = await getCampaignAccountIds(campaignIds);
  const [{ byAccount, failedCampaignIds }, workspaceDomains] = await Promise.all([
    getProjectMailboxes(campaignIds, accountByCampaign),
    loadOurSendingDomains(),
  ]);

  const notices: string[] = [];
  if (failedCampaignIds.length) {
    notices.push(
      `Не удалось узнать ящики части кампаний проекта (${failedCampaignIds.length}) — их письма могут не показаться. Обновите позже.`,
    );
  }
  const lanes = buildLanes(byAccount);
  if (!lanes.length) {
    return { letters: [], nextCursor: null, notices: [...notices, 'У кампаний проекта не нашлось ящиков.'] };
  }

  // Наши домены: все ящики основного аккаунта (датасет) и ящики проекта.
  const ourDomains = new Set(workspaceDomains);
  for (const mailboxes of byAccount.values()) {
    for (const mailbox of mailboxes.keys()) ourDomains.add(mailbox.split('@')[1] ?? '');
  }

  const cursors = cursor ? decodeCursor(cursor) : null;
  const active = cursors ? lanes.filter((lane) => lane.key in cursors) : lanes;
  // Экран открыт — человек ждёт ответа, поэтому до трёх пачек читаем в
  // интерактивной полосе: веер ограничен и не отнимает у сбора ответов больше
  // пары чтений. Больше трёх — это уже широкий веер, он идёт общей полосой
  // 'fresh', чтобы один экран не выедал интерактивную долю бюджета LIST.
  const requestPriority = active.length <= 3 ? 'interactive' : 'fresh';

  const nextCursors: Record<string, string> = {};
  const letters: { email: Email; campaignId: string }[] = [];
  let deferred = false;
  let failed = false;
  // Пачки по очереди: чтения одного воркспейса не пускаем залпом.
  for (const lane of active) {
    try {
      const response = await listEmails(
        {
          mode: 'emode_others',
          email_type: 'received',
          eaccount: lane.mailboxes.join(','),
          sort_order: 'desc',
          limit: PAGE_SIZE,
          search,
          starting_after: cursors?.[lane.key] || undefined,
        },
        { accountId: lane.accountId, timeoutMs: 20_000, requestPriority, consumer: 'personalization_others' },
      );
      const items = response.items ?? [];
      const laneMailboxes = byAccount.get(lane.accountId);
      for (const email of items) {
        if (isRobotLetter(email, ourDomains)) continue;
        // Письмо не на ящик проекта (фильтр Instantly не сработал) не показываем.
        const campaignId = laneMailboxes?.get((email.eaccount ?? '').trim().toLowerCase());
        if (campaignId) letters.push({ email, campaignId });
      }
      if (response.next_starting_after && items.length > 0) nextCursors[lane.key] = response.next_starting_after;
    } catch (err) {
      if (readInstantlyEmailReadDeferral(err)) deferred = true;
      else failed = true;
    }
  }
  if (deferred) notices.push('Instantly сейчас занят — часть писем не загрузилась. Обновите через минуту.');
  if (failed) notices.push('Instantly не ответил — часть писем не загрузилась. Обновите позже.');

  const page: LettersPage = { letters, nextCursor: encodeCursor(nextCursors), notices };
  // Страницу со сбоем не кэшируем: «Обновить» должен перечитать сразу.
  if (!deferred && !failed && !failedCampaignIds.length) cachePage(cacheKey, page);
  return page;
}
