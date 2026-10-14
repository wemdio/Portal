/**
 * ENG: раздел админки «Английские клиенты» (/admin/eng-clients) — модель
 * чтения списка и карточки клиента. Роуты api/admin/eng-clients(/[id]) только
 * зовут её; экраны — components/admin-eng.
 *
 * КТО В РАЗДЕЛЕ: profiles.role = 'client' AND profiles.market = 'eng'. Ровно
 * эти строки прячет /admin/users (components/admin-eng/usersFilter.ts —
 * то же правило), поэтому ни один аккаунт не пропадает из обоих мест сразу:
 * ENG-аккаунт с другой ролью остаётся в /admin/users.
 *
 * ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ. Ничего не пишется. Рассыльщик не читается, кроме
 * одного случая: карточка с `refresh` (кнопка «Обновить статусы кампаний»)
 * отдаёт readHeEngSendingSummaries(refresh: true) — фоновое живое чтение
 * статусов старше свежести через общий лимитер (engCampaignStatus); у
 * аккаунта с выключенной отправкой это же чтение ставит отправляющую кампанию
 * на паузу. Писем нет, LIST /emails нет.
 *
 * СПИСОК (readHeEngAdminList):
 *  - профили — до HE_ENG_ADMIN_PROFILES_CAP (по дате регистрации, новые
 *    первыми), страницами range() по HE_ENG_ADMIN_PAGE_ROWS (PostgREST больше
 *    1000 строк за запрос не отдаёт и режет молча); читается на одну строку
 *    больше предела — нашлась, значит профилей больше: `truncated`, экран
 *    пишет, что показаны не все;
 *  - бан входа (auth.users.banned_until) — у ВСЕХ строк, а не только у
 *    страницы (критик C1: аккаунт, забаненный до S3b, не имеет отметки
 *    блокировки, и чип «Бан без остановки» обязан найти его в любом месте
 *    списка). Источник — GoTrue admin listUsers постранично по
 *    HE_ENG_ADMIN_AUTH_PAGE: это ВСЕ пользователи портала (RU, сотрудники,
 *    ENG), чтение останавливается, как только найдены все ENG-аккаунты, на
 *    последней странице, на HE_ENG_ADMIN_AUTH_MAX_PAGES страницах или через
 *    HE_ENG_ADMIN_AUTH_BUDGET_MS. Остановилось раньше — `auth.state:
 *    'partial'`, у непрочитанных строк бан неизвестен («статус не прочитан»,
 *    ни в одном чипе бана), экран пишет «показаны не все». Строкам видимой
 *    страницы, чей бан не прочитан, — GoTrue getUserById по одному (не больше
 *    размера страницы, по 5 разом);
 *  - остальное — пачками `.in()` по HE_ENG_ADMIN_IN_CHUNK id, страницами по
 *    HE_ENG_ADMIN_PAGE_ROWS строк. Сбой ЛЮБОГО чтения — ошибка всего списка
 *    (роут отвечает 500): половинный список, где «Заблокирован» или
 *    «Отправляют» молча читаются как «нет», хуже пятисотки. Таблицы нет
 *    (миграция не применена) — не ошибка: источник помечен 'missing',
 *    экран называет миграцию, а чипы, которым он нужен, его не считают;
 *  - пул (полоса над списком) — he_sending_pool страницами range() по
 *    HE_ENG_ADMIN_PAGE_ROWS до предела роута пула (HE_ENG_ADMIN_POOL_LIMIT =
 *    его LIST_LIMIT) и ещё одной строки: она нашлась — строк больше предела,
 *    `limit_reached`, экран говорит, что счётчики неполные (W5).
 *
 * ЧИПЫ (считаются по всем строкам, не по странице; поиск их не меняет):
 *  - 'waiting'      «Ждут включения отправки» — аккаунт не заблокирован, и
 *                   отправку ждут от сотрудника (heEngAdminSendingWait):
 *                     · 'not_enabled', и клиент запускал: есть строка
 *                       намерения «Launch» (любая), строки автозапуска,
 *                       запущенный шаблон или отметка «упёрся в выключатель»
 *                       (requested_at). На requested_at одном не держится
 *                       (критик C10: на выключенном аккаунте роут «Launch»
 *                       отвечает 403 раньше, чем пишет отметку);
 *                     · 'revoked' только у разблокированного, кому отправку
 *                       выключила последняя блокировка (heEngAdminSendingOffBy
 *                       = 'block' при снятой отметке), и клиент запускал или
 *                       до блокировки отправка была включена / ждала / не
 *                       требовалась (sending_before). Значок «Разблокирован —
 *                       отправка выключена». Разблокировка снимает бан только
 *                       после подтверждённой остановки (engAccountBlock),
 *                       поэтому включать такую отправку можно сразу;
 *  - 'staff_off'    «Отправка выключена сотрудником» (серый) — аккаунт не
 *                   заблокирован, выключатель 'revoked', и это не очередь
 *                   'waiting': сотрудник выключил отправку кнопкой «Выключить
 *                   отправку» (без блокировки или уже после разблокировки),
 *                   её выключила блокировка клиента, который рынков не
 *                   запускал, или остановка «Заблокировать» / «Разблокировать»
 *                   без записанной отметки, или таблицы отметок нет и кто
 *                   выключил — не отличить. Подсказки «включите» у чипа нет, а
 *                   «Включить отправку» в карточке переспрашивает;
 *  - 'sending'      «Отправляют» — в кэше статусов есть отправляющая кампания;
 *  - 'attention'    «Нужна помощь» — не заблокирован и: проект 'failed',
 *                   автозапуск рынка 'failed' (любой код) или 'held'/'done' с
 *                   кодом, который чинит команда (HE_ENG_ADMIN_STAFF_CODES),
 *                   или рассыльщик остановил кампанию;
 *  - 'unverified'   «Почта не подтверждена»;
 *  - 'blocked'      «Заблокированы» — отметка блокировки активна ИЛИ бан входа
 *                   действует;
 *  - 'ban_no_stop'  «Бан без остановки» — бан действует, активной отметки нет
 *                   (забанен до S3b, в панели Supabase, или таблицы отметок
 *                   нет). Сам бан держит то, что читает его перед работой
 *                   (engAutoLaunch.readHeEngAccountStanding и письма клиенту
 *                   engClientMail): новые платные шаги, автозапуск, ночной
 *                   добор и письма клиенту. Не держит: кампании на паузу бан
 *                   не ставит (отправляют, пока отправка аккаунта включена),
 *                   уже поставленные задачи he_jobs идут (их клейм бан не
 *                   читает), долив ночного добора, прошедший проверку до бана,
 *                   доезжает.
 *                   Карточка зовёт «Заблокировать ещё раз / доставить
 *                   остановку»;
 *  - 'blocked_leak' «Заблокирован, но работа идёт» — отметка активна, и
 *                   (heEngAdminLeak): отправляющая кампания в кэше, активные
 *                   he_jobs, намерение «Launch» включено, автозапуск 'running'
 *                   с живой арендой, 'waiting'/'held' при включённом намерении
 *                   (критик C6: строки отменённого намерения тик не берёт), или
 *                   выключатель отправки не 'revoked'.
 *
 * НИЧЕГО ЗДЕСЬ НЕ БРОСАЕТ наружу: ответ — { ok } или { error }.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listInstantlyAccounts } from '@/lib/instantly/accounts';
import { HE_RESEARCH_STAGES } from './researchJob';
import { heEngSelectedVerticalIds } from './engMarkets';
import {
  heEngLastStopDoubt,
  heEngStopDoubtText,
  readHeEngAccountBlockRows,
  type HeEngAccountBlockRow,
  type HeEngBlockLine,
  type HeEngBlockReport,
  type HeEngSendingBefore,
} from './engAccountBlockMarker';
import { heEngStatusIsSending, heEngStatusIsStopped, type HeEngSendingSummary } from './engCampaignStatus';
import { readHeEngSendingSummaries, type HeEngLaunchRef } from './engCampaignSending';
import { heEngSendingActivationRequired, HE_ENG_SENDING_ACCESS_TABLE } from './engSendingAccess';
import {
  heSendingPoolAssignableWorkspaces,
  HE_SENDING_POOL_FORBIDDEN_WORKSPACE,
  HE_SENDING_POOL_TABLE,
  readHeSendingPoolSize,
  readHeSendingPoolWorkspace,
} from './sendingPool';
import { isHeEngEmailVerified, normalizeHeEngEmail, HE_ENG_EMAIL_VERIFICATIONS_TABLE } from './engEmailVerification';
import { readHeClientProviderSpend } from './engClientSpend';
import { readHeSpendCaps } from './spendCeiling';
import { engDashLaunchedTemplate } from './engDashboard';
import type { HeTemplateLaunchInfo } from './launchHandoff';
import type { HeEngAutoLaunchCode, HeEngAutoLaunchState } from './engAutoLaunch';
import { HE_ENG_ADMIN_FILTERS, isHeEngAdminFilter, type HeEngAdminFilter } from '@/components/admin-eng/filters';

/* ─────────────── Пределы ─────────────── */

/** Сколько ENG-профилей список читает (новые первыми); больше — `truncated`. */
export const HE_ENG_ADMIN_PROFILES_CAP = 2000;
/** Строк на странице списка по умолчанию и допустимые границы `per_page`. */
export const HE_ENG_ADMIN_PAGE_SIZE = 25;
export const HE_ENG_ADMIN_PAGE_SIZE_MIN = 10;
export const HE_ENG_ADMIN_PAGE_SIZE_MAX = 100;
/** id в одном `.in()`. */
export const HE_ENG_ADMIN_IN_CHUNK = 200;
/** Строк в одном ответе PostgREST (страница чтения). */
export const HE_ENG_ADMIN_PAGE_ROWS = 1000;
/** Страниц на один пакет id — дальше чтение считается сбоем, а не обрезается молча. */
const MAX_PAGES_PER_CHUNK = 50;
/** Предел чтения пула — тот же, что LIST_LIMIT роута api/tools/hypothesis-engine/sending-pool. */
export const HE_ENG_ADMIN_POOL_LIMIT = 2000;
/** GoTrue listUsers: пользователей на странице, страниц и времени на всё чтение. */
export const HE_ENG_ADMIN_AUTH_PAGE = 1000;
export const HE_ENG_ADMIN_AUTH_MAX_PAGES = 20;
export const HE_ENG_ADMIN_AUTH_BUDGET_MS = 20_000;
/** GoTrue getUserById для строк страницы, чей бан не прочитан: разом. */
const AUTH_PAGE_CONCURRENCY = 5;
/** Расход в карточке: не дольше. */
export const HE_ENG_ADMIN_SPEND_TIMEOUT_MS = 5_000;
/** Писем клиенту в карточке. */
const CLIENT_EMAILS_LIMIT = 20;
/** Статус кампании старше — экран печатает «статус от …». */
export const HE_ENG_ADMIN_STATUS_STALE_MS = 60 * 60_000;

/**
 * Коды автозапуска, которые чинит команда (чип «Нужна помощь» у 'held' и
 * 'done'): ядро отказало не по гейту, старт не удался, пул или пресет не
 * готовы. У 'failed' в чип идёт любой код.
 */
export const HE_ENG_ADMIN_STAFF_CODES: ReadonlySet<string> = new Set<HeEngAutoLaunchCode>([
  'needs_support',
  'start_failed',
  'setup_unavailable',
  'mailboxes_short',
]);

/* ─────────────── Типы ответа ─────────────── */

// Ключи чипов — общий словарь с экраном (модуль без зависимостей).
export { HE_ENG_ADMIN_FILTERS, isHeEngAdminFilter, type HeEngAdminFilter };

/** Бан входа строки. 'unread' — не прочитан (сбой или чтение остановилось раньше); 'missing' — пользователя в GoTrue нет. */
export type HeEngAdminAuth =
  | { state: 'read'; banned: boolean; banned_until: string | null; last_sign_in_at: string | null }
  | { state: 'unread' }
  | { state: 'missing' };

/** Отметка блокировки: 'unknown' — таблицы нет (миграция 20261013_0001 не применена). */
export type HeEngAdminMarkerState = 'active' | 'inactive' | 'none' | 'unknown';

/** Выключатель отправки (как на экране сотрудника — без снятия требования env). */
export type HeEngAdminSendingState = 'enabled' | 'not_enabled' | 'revoked' | 'missing';

/** Кто выключил отправку ('revoked'): блокировка, сотрудник или не отличить (нет таблицы отметок). */
export type HeEngAdminSendingOffBy = 'block' | 'staff' | 'unknown';

export type HeEngAdminVerification = 'yes' | 'backfill' | 'no' | 'unknown';

/** Что идёт у заблокированного аккаунта (чип «Заблокирован, но работа идёт»). */
export type HeEngAdminLeak =
  | { kind: 'campaigns_sending'; count: number; status_at: string | null }
  | { kind: 'active_jobs'; count: number }
  | { kind: 'intent_wanted' }
  | { kind: 'launch_running'; count: number }
  | { kind: 'auto_launch_waiting'; count: number }
  | { kind: 'switch_not_revoked'; state: HeEngAdminSendingState };

/** Почему аккаунту нужна помощь команды (чип «Нужна помощь»). */
export type HeEngAdminAttention =
  | { kind: 'project_failed' }
  | { kind: 'auto_launch'; state: HeEngAutoLaunchState; code: string | null; count: number }
  | { kind: 'campaigns_stopped'; count: number };

export interface HeEngAdminProjectBrief {
  id: string;
  name: string | null;
  website_url: string | null;
  status: string;
  error: string | null;
  cancelled_at: string | null;
  updated_at: string | null;
}

export interface HeEngAdminRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  company: string | null;
  signed_up_at: string | null;
  email_verified: HeEngAdminVerification;
  auth: HeEngAdminAuth;
  marker: HeEngAdminMarkerState;
  blocked_at: string | null;
  /** Бан действует, активной отметки нет. */
  ban_without_stop: boolean;
  /** Отметка активна, бан прочитан и не действует. */
  marker_without_ban: boolean;
  /** Самый свежий us-проект; null — проекта нет. */
  project: HeEngAdminProjectBrief | null;
  projects_count: number;
  markets: { selected: number; launched: number };
  sending: {
    state: HeEngAdminSendingState;
    /** 'enabled' — enabled_at; 'revoked' — revoked_at; 'not_enabled' и ждёт — с какого запроса; иначе null. */
    since: string | null;
    /** Чип «Ждут включения отправки». */
    waiting: boolean;
    /** Почему ждёт: 'launch' — запускал при невключённой отправке; 'unblocked' — разблокирован, отправку выключила блокировка (C10). */
    waiting_reason: 'launch' | 'unblocked' | null;
    /** С какого момента ждёт (порядок очереди): 'launch' — since, 'unblocked' — разблокировка. */
    waiting_since: string | null;
    /** Кто выключил ('revoked'): heEngAdminSendingOffBy; у других состояний null. */
    off_by: HeEngAdminSendingOffBy | null;
    /** Чип «Отправка выключена сотрудником». */
    staff_off: boolean;
  };
  campaigns: {
    total: number;
    sending: number;
    stopped: number;
    sent: number | null;
    replies: number | null;
    /** Самое старое время прочитанного статуса; null — ни у одной не прочитан. */
    oldest_status_at: string | null;
    /** Статус какой-то кампании не прочитан или старше HE_ENG_ADMIN_STATUS_STALE_MS. */
    stale: boolean;
    /** Кэш статусов не прочитан (таблицы нет). */
    unread: boolean;
  };
  active_jobs: number;
  /** Ящики пула у проектов аккаунта; null — пул не прочитан (таблицы нет). */
  mailboxes: number | null;
  intent: 'wanted' | 'cancelled' | 'none' | 'unknown';
  auto_launch: { waiting: number; running: number; running_stale: number; done: number; held: number; failed: number } | null;
  refill: 'on' | 'off' | 'paused' | 'none';
  support: { thread_id: string; awaiting_reply: boolean; last_message_at: string | null } | null;
  last_activity_at: string | null;
  leak: HeEngAdminLeak[];
  attention: HeEngAdminAttention[];
  chips: HeEngAdminFilter[];
}

/** Что из остановки блокировки не подтверждено (heEngLastStopDoubt) — фраза сотруднику; null — подтверждено. */
function heEngAdminStopDoubtText(lastStop: HeEngBlockReport | null): string | null {
  const doubt = heEngLastStopDoubt(lastStop);
  return doubt ? heEngStopDoubtText(doubt) : null;
}

/** Источник, без которого часть списка не считается: таблицы нет (миграция не применена). */
export type HeEngAdminSource =
  | 'marker'
  | 'verification'
  | 'sending_access'
  | 'campaign_status'
  | 'launch_intent'
  | 'auto_launch'
  | 'pool';

export interface HeEngAdminAuthSummary {
  /** 'complete' — бан прочитан у всех ENG-аккаунтов; 'partial' — не у всех; 'error' — чтение не удалось совсем. */
  state: 'complete' | 'partial' | 'error';
  /** Прочитано страниц GoTrue и пользователей на них. */
  pages: number;
  users_read: number;
  /** Всего пользователей по ответу GoTrue; null — не сказал. */
  users_total: number | null;
  /** Скольким ENG-строкам бан не прочитан (в чипы бана они не попали). */
  unread_rows: number;
}

export type HeEngAdminPool =
  | {
      state: 'ok';
      /** Воркспейс пула (куда добавлять ящики) и годится ли он. */
      workspace: string;
      workspace_problem: string | null;
      available: number;
      assigned: number;
      disabled: number;
      per_project: number;
      /** Сколько новых клиентов получат ящики: по каждому воркспейсу выдачи floor(свободно / на проект). */
      fits_new_clients: number;
      held_by_blocked: { mailboxes: number; projects: number };
      /** Прочитано строк (не больше limit). */
      rows_read: number;
      limit: number;
      /** Строк в пуле больше limit — прочитаны первые limit, счётчики неполные. */
      limit_reached: boolean;
    }
  | { state: 'missing' }
  | { state: 'error' };

export interface HeEngAdminList {
  total: number;
  page: number;
  per_page: number;
  /** Профилей больше HE_ENG_ADMIN_PROFILES_CAP — прочитаны первые (новые). */
  truncated: boolean;
  profiles_cap: number;
  counts: Record<HeEngAdminFilter, number>;
  /** Таблицы, которых нет (миграция не применена). */
  missing: HeEngAdminSource[];
  auth: HeEngAdminAuthSummary;
  pool: HeEngAdminPool;
  rows: HeEngAdminRow[];
}

/* ─────────────── GoTrue ─────────────── */

export interface HeEngAdminAuthUser {
  id: string;
  banned_until: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
}

/** Обёртка над supabase.auth.admin (подменяется в проверках). НЕ БРОСАЕТ. */
export interface HeEngAdminAuthApi {
  listUsersPage(page: number, perPage: number): Promise<{ users: HeEngAdminAuthUser[]; total: number | null } | { error: string }>;
  getUserById(id: string): Promise<{ user: HeEngAdminAuthUser } | { missing: true } | { error: string }>;
}

function authUserOf(raw: unknown): HeEngAdminAuthUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    banned_until: strOrNull(r.banned_until),
    last_sign_in_at: strOrNull(r.last_sign_in_at),
    email_confirmed_at: strOrNull(r.email_confirmed_at),
  };
}

export function heEngAdminAuthApi(db: SupabaseClient): HeEngAdminAuthApi {
  return {
    async listUsersPage(page, perPage) {
      try {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage });
        if (error) return { error: String(error.message ?? 'listUsers failed').slice(0, 200) };
        const users = (data?.users ?? []).map(authUserOf).filter((u): u is HeEngAdminAuthUser => u !== null);
        const total = typeof (data as { total?: unknown }).total === 'number' ? (data as { total: number }).total : null;
        return { users, total: total && total > 0 ? total : null };
      } catch (e) {
        return { error: e instanceof Error ? e.message.slice(0, 200) : 'listUsers threw' };
      }
    },
    async getUserById(id) {
      try {
        const { data, error } = await db.auth.admin.getUserById(id);
        if (error) {
          const e = error as { status?: number; code?: string; message?: string };
          if (e.status === 404 || e.code === 'user_not_found') return { missing: true };
          return { error: String(e.message ?? 'getUserById failed').slice(0, 200) };
        }
        const user = authUserOf(data?.user);
        return user ? { user } : { missing: true };
      } catch (e) {
        return { error: e instanceof Error ? e.message.slice(0, 200) : 'getUserById threw' };
      }
    },
  };
}

/** Бан действует: срок в будущем; непарсящийся срок — тоже бан (как readHeEngAccountStanding). */
export function heEngAdminBanned(bannedUntil: string | null, nowMs: number): boolean {
  const raw = (bannedUntil ?? '').trim();
  if (!raw) return false;
  const until = Date.parse(raw);
  return !Number.isFinite(until) || until > nowMs;
}

function authViewOf(user: HeEngAdminAuthUser, nowMs: number): HeEngAdminAuth {
  return {
    state: 'read',
    banned: heEngAdminBanned(user.banned_until, nowMs),
    banned_until: user.banned_until,
    last_sign_in_at: user.last_sign_in_at,
  };
}

/**
 * Бан всех ENG-аккаунтов одним проходом по пользователям GoTrue (см. шапку:
 * страницы, предел, бюджет времени). `byId` — найденные; найденных нет и
 * чтение 'complete' — пользователя в GoTrue нет.
 */
async function readAuthForAll(
  api: HeEngAdminAuthApi,
  ids: ReadonlySet<string>,
  clock: () => number,
): Promise<{ state: 'complete' | 'partial' | 'error'; byId: Map<string, HeEngAdminAuthUser>; pages: number; usersRead: number; total: number | null }> {
  const byId = new Map<string, HeEngAdminAuthUser>();
  const started = clock();
  let pages = 0;
  let usersRead = 0;
  let total: number | null = null;
  if (ids.size === 0) return { state: 'complete', byId, pages, usersRead, total };
  for (let page = 1; page <= HE_ENG_ADMIN_AUTH_MAX_PAGES; page += 1) {
    if (page > 1 && clock() - started > HE_ENG_ADMIN_AUTH_BUDGET_MS) {
      return { state: 'partial', byId, pages, usersRead, total };
    }
    const res = await api.listUsersPage(page, HE_ENG_ADMIN_AUTH_PAGE);
    if ('error' in res) return { state: page === 1 ? 'error' : 'partial', byId, pages, usersRead, total };
    pages += 1;
    usersRead += res.users.length;
    total = res.total ?? total;
    for (const user of res.users) if (ids.has(user.id)) byId.set(user.id, user);
    // Нашлись все — дальше читать незачем; страница неполная — пользователи кончились.
    if (byId.size >= ids.size || res.users.length < HE_ENG_ADMIN_AUTH_PAGE) {
      return { state: 'complete', byId, pages, usersRead, total };
    }
  }
  return { state: 'partial', byId, pages, usersRead, total };
}

/* ─────────────── Чтение пачками ─────────────── */

type Row = Record<string, unknown>;
type PgError = { code?: string | null; message?: string | null };
type ReadResult = PromiseLike<{ data: unknown[] | null; error: PgError | null }>;
type SourceRead = { state: 'ok'; rows: Row[] } | { state: 'missing' } | { state: 'error'; detail: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function tsOf(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

function isTableMissing(error: PgError | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42P01' || code === 'PGRST205';
}

function errText(prefix: string, error: PgError | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

/**
 * Строки по списку id: пакеты по HE_ENG_ADMIN_IN_CHUNK, в пакете — страницы
 * по HE_ENG_ADMIN_PAGE_ROWS (`read` получает границы range и обязан
 * упорядочить выборку). Таблицы нет — 'missing'; любой другой сбой и пакет
 * длиннее MAX_PAGES_PER_CHUNK страниц — 'error'. НЕ БРОСАЕТ.
 */
async function readByIds(
  label: string,
  ids: readonly string[],
  read: (part: string[], from: number, to: number) => ReadResult,
): Promise<SourceRead> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const rows: Row[] = [];
  try {
    for (let i = 0; i < unique.length; i += HE_ENG_ADMIN_IN_CHUNK) {
      const part = unique.slice(i, i + HE_ENG_ADMIN_IN_CHUNK);
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PAGES_PER_CHUNK) return { state: 'error', detail: `${label}: more than ${MAX_PAGES_PER_CHUNK} pages` };
        const from = page * HE_ENG_ADMIN_PAGE_ROWS;
        const { data, error } = await read(part, from, from + HE_ENG_ADMIN_PAGE_ROWS - 1);
        if (error) return isTableMissing(error) ? { state: 'missing' } : { state: 'error', detail: errText(label, error) };
        const got = (data ?? []) as Row[];
        rows.push(...got);
        if (got.length < HE_ENG_ADMIN_PAGE_ROWS) break;
      }
    }
  } catch (e) {
    return { state: 'error', detail: `${label} threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
  return { state: 'ok', rows };
}

/**
 * Одна выборка страницами range() по HE_ENG_ADMIN_PAGE_ROWS, пока не
 * наберётся `max` строк или страница не придёт неполной (`read` получает
 * границы range и обязан упорядочить выборку однозначно). { error } — сбой
 * любой страницы; брошенное — наружу (вызывающий ловит).
 */
async function readCapped(
  max: number,
  read: (from: number, to: number) => ReadResult,
): Promise<{ rows: Row[] } | { error: PgError }> {
  const rows: Row[] = [];
  while (rows.length < max) {
    const from = rows.length;
    const want = Math.min(HE_ENG_ADMIN_PAGE_ROWS, max - from);
    const { data, error } = await read(from, from + want - 1);
    if (error) return { error };
    const got = ((data ?? []) as Row[]).slice(0, want);
    rows.push(...got);
    if (got.length < want) break;
  }
  return { rows };
}

function groupBy(rows: readonly Row[], key: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const k = str(row[key]);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function indexBy(rows: readonly Row[], key: string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const row of rows) {
    const k = str(row[key]);
    if (k) out.set(k, row);
  }
  return out;
}

/* ─────────────── Снимок источников ─────────────── */

const PROJECT_COLUMNS =
  'id, created_by, name, website_url, status, error, created_at, updated_at, autopilot, autopilot_error, autopilot_error_at';

/** Все источники аккаунтов списка / карточки. null у карты — таблицы нет. */
interface Snapshot {
  nowMs: number;
  markers: Map<string, HeEngAccountBlockRow> | null;
  verifications: Map<string, Row> | null;
  access: Map<string, Row> | null;
  projectsByUser: Map<string, Row[]>;
  activeJobs: Map<string, Row[]>;
  selected: Map<string, string[]>;
  launched: Map<string, Set<string>>;
  intents: Map<string, Row> | null;
  autoRows: Map<string, Row[]> | null;
  campaigns: Map<string, Row[]> | null;
  mailboxes: Map<string, Row[]> | null;
  refill: Map<string, Row>;
  threads: Map<string, Row>;
}

type SnapshotRead = { ok: true; snapshot: Snapshot; missing: HeEngAdminSource[] } | { ok: false; detail: string };

/**
 * Прочитать все источники аккаунтов `userIds`. Любой сбой (кроме «таблицы
 * нет» у источников новых миграций) — { ok: false }. НЕ БРОСАЕТ.
 */
async function readSnapshot(db: SupabaseClient, userIds: readonly string[], nowMs: number): Promise<SnapshotRead> {
  const missing: HeEngAdminSource[] = [];
  const fail = (detail: string): SnapshotRead => ({ ok: false, detail });

  const markersRead = await readHeEngAccountBlockRows(db, userIds);
  if (markersRead.state === 'error') return fail(markersRead.detail);
  if (markersRead.state === 'missing') missing.push('marker');

  const [verifRead, accessRead, threadsRead, projectsFirst] = await Promise.all([
    readByIds('he_eng_email_verifications', userIds, (part, from, to) =>
      db
        .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
        .select('user_id, email, verified_at, last_sent_at, created_at')
        .in('user_id', part)
        .order('user_id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_eng_sending_access', userIds, (part, from, to) =>
      db
        .from(HE_ENG_SENDING_ACCESS_TABLE)
        .select('user_id, enabled, requested_at, enabled_at, revoked_at, email_sent_at')
        .in('user_id', part)
        .order('user_id', { ascending: true })
        .range(from, to),
    ),
    readByIds('client_support_threads', userIds, (part, from, to) =>
      db
        .from('client_support_threads')
        .select('id, client_user_id, last_message_at, last_message_role')
        .in('client_user_id', part)
        .order('client_user_id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_projects', userIds, (part, from, to) =>
      db
        .from('he_projects')
        .select(`${PROJECT_COLUMNS}, cancelled_at`)
        .in('created_by', part)
        .eq('market', 'us')
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);
  if (verifRead.state === 'error') return fail(verifRead.detail);
  if (verifRead.state === 'missing') missing.push('verification');
  if (accessRead.state === 'error') return fail(accessRead.detail);
  if (accessRead.state === 'missing') missing.push('sending_access');
  if (threadsRead.state !== 'ok') return fail(threadsRead.state === 'error' ? threadsRead.detail : 'client_support_threads missing');

  // Колонки cancelled_at нет (миграция 20261009_0002 не применена) — без неё.
  let projectsRead = projectsFirst;
  if (projectsRead.state === 'error' && /cancelled_at/.test(projectsRead.detail)) {
    projectsRead = await readByIds('he_projects', userIds, (part, from, to) =>
      db
        .from('he_projects')
        .select(PROJECT_COLUMNS)
        .in('created_by', part)
        .eq('market', 'us')
        .order('id', { ascending: true })
        .range(from, to),
    );
  }
  if (projectsRead.state !== 'ok') return fail(projectsRead.state === 'error' ? projectsRead.detail : 'he_projects missing');
  const projectRows = projectsRead.rows;
  const projectIds = projectRows.map((p) => str(p.id)).filter(Boolean);

  const [jobsRead, hypRead, vertRead, intentRead, autoRead, campaignRead, poolRead, refillFirst] = await Promise.all([
    readByIds('he_jobs', projectIds, (part, from, to) =>
      db
        .from('he_jobs')
        .select('id, project_id, stage, status, created_at, started_at')
        .in('project_id', part)
        .in('status', ['pending', 'running'])
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_hypotheses', projectIds, (part, from, to) =>
      db
        .from('he_hypotheses')
        .select('id, project_id, vertical_id, status')
        .in('project_id', part)
        .eq('status', 'accepted')
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_verticals', projectIds, (part, from, to) =>
      db
        .from('he_verticals')
        .select('id, project_id')
        .in('project_id', part)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_eng_launch_intent', projectIds, (part, from, to) =>
      db
        .from('he_eng_launch_intent')
        .select('project_id, wanted, requested_at, cancelled_at, settled_at')
        .in('project_id', part)
        .order('project_id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_eng_auto_launch', projectIds, (part, from, to) =>
      db
        .from('he_eng_auto_launch')
        .select('template_id, project_id, state, code, next_at, lease_until, updated_at')
        .in('project_id', part)
        .order('template_id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_eng_campaign_status', projectIds, (part, from, to) =>
      db
        .from('he_eng_campaign_status')
        .select('campaign_id, project_id, status, status_read_at, sent, replies, counts_read_at, read_error, start_error')
        .in('project_id', part)
        .order('campaign_id', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_sending_pool', projectIds, (part, from, to) =>
      db
        .from(HE_SENDING_POOL_TABLE)
        .select('email, instantly_account_id, project_id, assigned_at')
        .in('project_id', part)
        .eq('status', 'assigned')
        .order('email', { ascending: true })
        .range(from, to),
    ),
    readByIds('he_auto_pipeline_configs', projectIds, (part, from, to) =>
      db
        .from('he_auto_pipeline_configs')
        .select('project_id, enabled, refill_paused_at, refill_pause_reason')
        .in('project_id', part)
        .order('project_id', { ascending: true })
        .range(from, to),
    ),
  ]);
  for (const r of [jobsRead, hypRead, vertRead]) {
    if (r.state !== 'ok') return fail(r.state === 'error' ? r.detail : 'he_* core table missing');
  }
  for (const [r, source] of [
    [intentRead, 'launch_intent'],
    [autoRead, 'auto_launch'],
    [campaignRead, 'campaign_status'],
    [poolRead, 'pool'],
  ] as const) {
    if (r.state === 'error') return fail(r.detail);
    if (r.state === 'missing') missing.push(source);
  }
  // Колонок паузы добора нет (старая схема) — только enabled.
  let refillRead = refillFirst;
  if (refillRead.state === 'error' && /refill_pause/.test(refillRead.detail)) {
    refillRead = await readByIds('he_auto_pipeline_configs', projectIds, (part, from, to) =>
      db
        .from('he_auto_pipeline_configs')
        .select('project_id, enabled')
        .in('project_id', part)
        .order('project_id', { ascending: true })
        .range(from, to),
    );
  }
  if (refillRead.state === 'error') return fail(refillRead.detail);

  // Запущенные рынки: шаблоны с launch_info у вертикалей проектов.
  const verticalRows = vertRead.state === 'ok' ? vertRead.rows : [];
  const projectOfVertical = new Map(verticalRows.map((v) => [str(v.id), str(v.project_id)]));
  const templatesRead = await readByIds(
    'he_templates',
    verticalRows.map((v) => str(v.id)),
    (part, from, to) =>
      db
        .from('he_templates')
        .select('id, vertical_id')
        .in('vertical_id', part)
        .not('launch_info', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
  );
  if (templatesRead.state !== 'ok') return fail(templatesRead.state === 'error' ? templatesRead.detail : 'he_templates missing');
  const launched = new Map<string, Set<string>>();
  for (const t of templatesRead.rows) {
    const vid = str(t.vertical_id);
    const pid = projectOfVertical.get(vid);
    if (!pid) continue;
    const set = launched.get(pid) ?? new Set<string>();
    set.add(vid);
    launched.set(pid, set);
  }

  const selected = new Map<string, string[]>();
  for (const [pid, rows] of groupBy(hypRead.state === 'ok' ? hypRead.rows : [], 'project_id')) {
    selected.set(pid, heEngSelectedVerticalIds(rows));
  }

  return {
    ok: true,
    missing,
    snapshot: {
      nowMs,
      markers: markersRead.state === 'ok' ? new Map(markersRead.rows) : null,
      verifications: verifRead.state === 'ok' ? indexBy(verifRead.rows, 'user_id') : null,
      access: accessRead.state === 'ok' ? indexBy(accessRead.rows, 'user_id') : null,
      projectsByUser: groupBy(projectRows, 'created_by'),
      activeJobs: groupBy(jobsRead.state === 'ok' ? jobsRead.rows : [], 'project_id'),
      selected,
      launched,
      intents: intentRead.state === 'ok' ? indexBy(intentRead.rows, 'project_id') : null,
      autoRows: autoRead.state === 'ok' ? groupBy(autoRead.rows, 'project_id') : null,
      campaigns: campaignRead.state === 'ok' ? groupBy(campaignRead.rows, 'project_id') : null,
      mailboxes: poolRead.state === 'ok' ? groupBy(poolRead.rows, 'project_id') : null,
      refill: refillRead.state === 'ok' ? indexBy(refillRead.rows, 'project_id') : new Map(),
      threads: indexBy(threadsRead.rows, 'client_user_id'),
    },
  };
}

/* ─────────────── Строка аккаунта (чистая функция) ─────────────── */

export interface HeEngAdminProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  company: string | null;
  created_at: string | null;
}

function verificationOf(row: Row | null | undefined, available: boolean, email: string | null): HeEngAdminVerification {
  if (!available) return 'unknown';
  if (!row) return 'no';
  const verifiedAt = strOrNull(row.verified_at);
  const verified = isHeEngEmailVerified(
    { email: str(row.email), verified_at: verifiedAt, token_hash: null, last_sent_at: strOrNull(row.last_sent_at) },
    normalizeHeEngEmail(email),
  );
  if (!verified) return 'no';
  // Строка, заведённая миграцией 20261010_0001 старым аккаунтам: verified_at = created_at, ссылки не было.
  return verifiedAt === strOrNull(row.created_at) && !strOrNull(row.last_sent_at) ? 'backfill' : 'yes';
}

function sendingStateOf(row: Row | null | undefined, available: boolean): HeEngAdminSendingState {
  if (!available) return 'missing';
  if (row?.enabled === true) return 'enabled';
  if (strOrNull(row?.revoked_at)) return 'revoked';
  return 'not_enabled';
}

function minIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) if (v && tsOf(v) > 0 && (!best || tsOf(v) < tsOf(best))) best = v;
  return best;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) if (v && tsOf(v) > 0 && (!best || tsOf(v) > tsOf(best))) best = v;
  return best;
}

function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/**
 * Что идёт у аккаунта с активной отметкой (критик C6). Пусто — ничего.
 * Строки автозапуска считаются, только когда тик может их взять: 'running' —
 * с живой арендой, 'waiting' / 'held' — при включённом намерении.
 */
export function heEngAdminLeak(input: {
  sendingCampaigns: number;
  statusAt: string | null;
  activeJobs: number;
  intentWanted: boolean;
  runningLive: number;
  waitingOrHeld: number;
  sendingState: HeEngAdminSendingState;
}): HeEngAdminLeak[] {
  const out: HeEngAdminLeak[] = [];
  if (input.sendingCampaigns > 0) out.push({ kind: 'campaigns_sending', count: input.sendingCampaigns, status_at: input.statusAt });
  if (input.activeJobs > 0) out.push({ kind: 'active_jobs', count: input.activeJobs });
  if (input.intentWanted) out.push({ kind: 'intent_wanted' });
  if (input.runningLive > 0) out.push({ kind: 'launch_running', count: input.runningLive });
  if (input.intentWanted && input.waitingOrHeld > 0) out.push({ kind: 'auto_launch_waiting', count: input.waitingOrHeld });
  if (input.sendingState !== 'revoked') out.push({ kind: 'switch_not_revoked', state: input.sendingState });
  return out;
}

/**
 * Кто выключил отправку аккаунта в состоянии 'revoked':
 *  - 'block'   — блокировка: строка отметки есть, revoked_at не раньше начала
 *                её эпизода (blocked_at), а у снятой отметки ещё и не позже
 *                разблокировки (unblocked_at). Выключатель, выключенный до
 *                блокировки, она не переписывает (setHeEngSendingAccess:
 *                повтор того же состояния revoked_at не трогает) — такой
 *                revoked_at раньше blocked_at, и это 'staff';
 *  - 'staff'   — иначе: «Выключить отправку» без блокировки, до неё или уже
 *                после разблокировки;
 *  - 'unknown' — таблицы отметок нет (миграция 20261013_0001): не отличить.
 * Известная неточность в сторону «сотрудник»: первое нажатие блокировки не
 * записало отметку, но выключило отправку, а отметку записало повторное —
 * тогда revoked_at раньше blocked_at, и аккаунт уходит в 'staff'.
 */
export function heEngAdminSendingOffBy(
  revokedAt: string | null,
  marker: Pick<HeEngAccountBlockRow, 'active' | 'blockedAt' | 'unblockedAt'> | null,
  markersRead: boolean,
): HeEngAdminSendingOffBy {
  if (!markersRead) return 'unknown';
  if (!marker || !revokedAt) return 'staff';
  const revoked = tsOf(revokedAt);
  if (revoked <= 0 || revoked < tsOf(marker.blockedAt)) return 'staff';
  if (marker.active) return 'block';
  const unblocked = tsOf(marker.unblockedAt);
  return unblocked > 0 && unblocked >= revoked ? 'block' : 'staff';
}

/** Состояния выключателя до блокировки, после которых разблокированный ждёт включения и без следа запуска. */
const WAIT_AFTER_UNBLOCK_BEFORE: ReadonlySet<HeEngSendingBefore> = new Set<HeEngSendingBefore>(['enabled', 'waiting', 'not_required']);

/**
 * Ждёт ли аккаунт включения отправки от сотрудника (чип 'waiting') и, если
 * 'revoked' не ждёт, — серый чип 'staff_off'. Заблокированный — ни то, ни
 * другое (он в «Заблокированы»). Правила — в шапке модуля.
 */
export function heEngAdminSendingWait(input: {
  blocked: boolean;
  state: HeEngAdminSendingState;
  launchSignal: boolean;
  offBy: HeEngAdminSendingOffBy | null;
  marker: Pick<HeEngAccountBlockRow, 'active' | 'unblockedAt' | 'sendingBefore'> | null;
}): { reason: 'launch' | 'unblocked' | null; staffOff: boolean } {
  if (input.blocked) return { reason: null, staffOff: false };
  if (input.state === 'not_enabled') return { reason: input.launchSignal ? 'launch' : null, staffOff: false };
  if (input.state !== 'revoked') return { reason: null, staffOff: false };
  const m = input.marker;
  const unblocked = input.offBy === 'block' && m !== null && !m.active;
  if (unblocked && (input.launchSignal || WAIT_AFTER_UNBLOCK_BEFORE.has(m.sendingBefore))) {
    return { reason: 'unblocked', staffOff: false };
  }
  return { reason: null, staffOff: true };
}

export function buildHeEngAdminRow(s: Snapshot, profile: HeEngAdminProfile, auth: HeEngAdminAuth): HeEngAdminRow {
  const uid = profile.id;
  const projects = [...(s.projectsByUser.get(uid) ?? [])].sort((a, b) => tsOf(b.created_at) - tsOf(a.created_at));
  const pids = projects.map((p) => str(p.id));
  const latest = projects[0] ?? null;

  const markerRow = s.markers ? s.markers.get(uid) ?? null : null;
  const marker: HeEngAdminMarkerState = s.markers === null ? 'unknown' : !markerRow ? 'none' : markerRow.active ? 'active' : 'inactive';
  const banned = auth.state === 'read' ? auth.banned : null;
  const blockedAny = marker === 'active' || banned === true;

  const accessRow = s.access?.get(uid) ?? null;
  const sendingState = sendingStateOf(accessRow, s.access !== null);

  let selectedCount = 0;
  let launchedCount = 0;
  let activeJobs = 0;
  const campaignRows: Row[] = [];
  const autoRows: Row[] = [];
  let mailboxes = 0;
  let intentWanted = false;
  let intentAny = false;
  const intentRequested: Array<string | null> = [];
  let refill: HeEngAdminRow['refill'] = 'none';
  let projectFailed = false;
  for (const p of projects) {
    const pid = str(p.id);
    selectedCount += (s.selected.get(pid) ?? []).length;
    launchedCount += (s.launched.get(pid) ?? new Set()).size;
    activeJobs += (s.activeJobs.get(pid) ?? []).length;
    campaignRows.push(...(s.campaigns?.get(pid) ?? []));
    autoRows.push(...(s.autoRows?.get(pid) ?? []));
    mailboxes += (s.mailboxes?.get(pid) ?? []).length;
    const intent = s.intents?.get(pid);
    if (intent) {
      intentAny = true;
      if (intent.wanted === true) intentWanted = true;
      intentRequested.push(strOrNull(intent.requested_at));
    }
    const cfg = s.refill.get(pid);
    if (cfg) {
      const state = cfg.enabled !== true ? 'off' : strOrNull(cfg.refill_paused_at) ? 'paused' : 'on';
      // Несколько проектов: «включён» важнее «на паузе», «на паузе» — чем «выключен».
      const rank = { none: 0, off: 1, paused: 2, on: 3 } as const;
      if (rank[state] > rank[refill]) refill = state;
    }
    if (str(p.status) === 'failed') projectFailed = true;
  }

  // Кампании (кэш статусов).
  const statusTimes = campaignRows.map((c) => strOrNull(c.status_read_at));
  const sendingCampaigns = campaignRows.filter((c) => heEngStatusIsSending(numOrNull(c.status))).length;
  const stoppedCampaigns = campaignRows.filter((c) => heEngStatusIsStopped(numOrNull(c.status))).length;
  const oldestStatusAt = minIso(statusTimes);
  const stale =
    campaignRows.length > 0
    && (statusTimes.some((t) => !t) || (oldestStatusAt !== null && s.nowMs - tsOf(oldestStatusAt) > HE_ENG_ADMIN_STATUS_STALE_MS));

  // Автозапуск.
  const al = { waiting: 0, running: 0, running_stale: 0, done: 0, held: 0, failed: 0 };
  for (const r of autoRows) {
    const state = str(r.state);
    if (state === 'running') {
      if (tsOf(r.lease_until) > s.nowMs) al.running += 1;
      else al.running_stale += 1;
    } else if (state === 'waiting' || state === 'done' || state === 'held' || state === 'failed') {
      al[state] += 1;
    }
  }

  // Ждёт включения отправки (C10) или выключена сотрудником (heEngAdminSendingWait).
  const launchSignal =
    intentAny || autoRows.length > 0 || launchedCount > 0 || strOrNull(accessRow?.requested_at) !== null;
  const offBy = sendingState === 'revoked' ? heEngAdminSendingOffBy(strOrNull(accessRow?.revoked_at), markerRow, s.markers !== null) : null;
  const wait = heEngAdminSendingWait({ blocked: blockedAny, state: sendingState, launchSignal, offBy, marker: markerRow });
  const waiting = wait.reason !== null;
  const since =
    sendingState === 'enabled'
      ? strOrNull(accessRow?.enabled_at)
      : sendingState === 'revoked'
        ? strOrNull(accessRow?.revoked_at)
        : sendingState === 'not_enabled' && waiting
          ? minIso([strOrNull(accessRow?.requested_at), ...intentRequested])
          : null;
  const waitingSince = wait.reason === 'unblocked' ? markerRow?.unblockedAt ?? null : wait.reason === 'launch' ? since : null;

  const leak =
    marker === 'active'
      ? heEngAdminLeak({
          sendingCampaigns,
          statusAt: oldestStatusAt,
          activeJobs,
          intentWanted,
          runningLive: al.running,
          waitingOrHeld: al.waiting + al.held,
          sendingState,
        })
      : [];

  const attention: HeEngAdminAttention[] = [];
  if (!blockedAny) {
    if (projectFailed) attention.push({ kind: 'project_failed' });
    const byCode = new Map<string, { state: HeEngAutoLaunchState; code: string | null; count: number }>();
    for (const r of autoRows) {
      const state = str(r.state) as HeEngAutoLaunchState;
      const code = strOrNull(r.code);
      const staff = state === 'failed' || ((state === 'held' || state === 'done') && code !== null && HE_ENG_ADMIN_STAFF_CODES.has(code));
      if (!staff) continue;
      const key = `${state}|${code ?? ''}`;
      const entry = byCode.get(key) ?? { state, code, count: 0 };
      entry.count += 1;
      byCode.set(key, entry);
    }
    for (const entry of byCode.values()) attention.push({ kind: 'auto_launch', ...entry });
    if (stoppedCampaigns > 0) attention.push({ kind: 'campaigns_stopped', count: stoppedCampaigns });
  }

  const verification = verificationOf(s.verifications?.get(uid), s.verifications !== null, profile.email);
  const thread = s.threads.get(uid) ?? null;
  const support = thread
    ? {
        thread_id: str(thread.id),
        awaiting_reply: str(thread.last_message_role) === 'client',
        last_message_at: strOrNull(thread.last_message_at),
      }
    : null;

  const chips: HeEngAdminFilter[] = ['all'];
  if (waiting) chips.push('waiting');
  if (wait.staffOff) chips.push('staff_off');
  if (sendingCampaigns > 0) chips.push('sending');
  if (attention.length > 0) chips.push('attention');
  if (verification === 'no') chips.push('unverified');
  if (blockedAny) chips.push('blocked');
  const banWithoutStop = banned === true && marker !== 'active';
  if (banWithoutStop) chips.push('ban_no_stop');
  if (leak.length > 0) chips.push('blocked_leak');

  return {
    user_id: uid,
    email: profile.email,
    full_name: profile.full_name,
    company: profile.company,
    signed_up_at: profile.created_at,
    email_verified: verification,
    auth,
    marker,
    blocked_at: markerRow?.active ? markerRow.blockedAt || null : null,
    ban_without_stop: banWithoutStop,
    marker_without_ban: marker === 'active' && banned === false,
    project: latest
      ? {
          id: str(latest.id),
          name: strOrNull(latest.name),
          website_url: strOrNull(latest.website_url),
          status: str(latest.status),
          error: strOrNull(latest.error),
          cancelled_at: strOrNull(latest.cancelled_at),
          updated_at: strOrNull(latest.updated_at),
        }
      : null,
    projects_count: pids.length,
    markets: { selected: selectedCount, launched: launchedCount },
    sending: {
      state: sendingState,
      since,
      waiting,
      waiting_reason: wait.reason,
      waiting_since: waitingSince,
      off_by: offBy,
      staff_off: wait.staffOff,
    },
    campaigns: {
      total: campaignRows.length,
      sending: sendingCampaigns,
      stopped: stoppedCampaigns,
      sent: campaignRows.length > 0 ? sumOrNull(campaignRows.map((c) => numOrNull(c.sent))) : null,
      replies: campaignRows.length > 0 ? sumOrNull(campaignRows.map((c) => numOrNull(c.replies))) : null,
      oldest_status_at: oldestStatusAt,
      stale,
      unread: s.campaigns === null,
    },
    active_jobs: activeJobs,
    mailboxes: s.mailboxes === null ? null : mailboxes,
    intent: s.intents === null ? 'unknown' : intentWanted ? 'wanted' : intentAny ? 'cancelled' : 'none',
    auto_launch: s.autoRows === null ? null : al,
    refill,
    support,
    last_activity_at: maxIso([
      ...projects.map((p) => strOrNull(p.updated_at)),
      ...intentRequested,
      support?.awaiting_reply ? support.last_message_at : null,
      auth.state === 'read' ? auth.last_sign_in_at : null,
    ]),
    leak,
    attention,
    chips,
  };
}

/* ─────────────── Отчёт снятой блокировки ─────────────── */

/** Призыв «нажмите «Заблокировать ещё раз»…» до конца строки (точка перед ним остаётся). */
const REBLOCK_CALL = /(\.)?\s*(?:[—;,]\s*)?[Нн]ажмите «Заблокировать ещё раз[\s\S]*$/;

/**
 * Строки сохранённого отчёта блокировки, когда она уже снята (карточка:
 * «Последняя блокировка (снята)»). Отчёт рассказывает о прошлом нажатии, а
 * «Заблокировать ещё раз» у разблокированного клиента блокирует его снова, а
 * не довершает ту остановку. Поэтому красные строки становятся пояснениями
 * ('note'), а призыв «нажмите «Заблокировать ещё раз»» вырезается вместе с
 * остатком фразы. Заголовок «Отчёт снятой блокировки от …» пишет экран.
 */
export function heEngAdminHistoryLines(lines: readonly HeEngBlockLine[]): HeEngBlockLine[] {
  return lines.map((line) => {
    const text = line.text.replace(REBLOCK_CALL, (_m, dot: string | undefined) => dot ?? '').trim();
    return { tone: line.tone === 'red' ? 'note' : line.tone, text: text || line.text };
  });
}

/* ─────────────── Порядок, поиск, страница ─────────────── */

/** Сначала красное (бан без остановки, работа идёт), потом ждущие включения, потом «нужна помощь», потом остальные. */
function priority(row: HeEngAdminRow): number {
  if (row.chips.includes('ban_no_stop') || row.chips.includes('blocked_leak')) return 0;
  if (row.chips.includes('waiting')) return 1;
  if (row.chips.includes('attention')) return 2;
  return 3;
}

export function sortHeEngAdminRows(rows: HeEngAdminRow[]): HeEngAdminRow[] {
  return [...rows].sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    // Ждущие — кто ждёт дольше, тот выше (разблокированный — с разблокировки).
    if (pa === 1) {
      const sa = tsOf(a.sending.waiting_since) || Number.MAX_SAFE_INTEGER;
      const sb = tsOf(b.sending.waiting_since) || Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
    }
    const la = tsOf(a.last_activity_at);
    const lb = tsOf(b.last_activity_at);
    if (la !== lb) return lb - la;
    return tsOf(b.signed_up_at) - tsOf(a.signed_up_at);
  });
}

/** Поиск по почте, имени, компании и сайту (подстрока, без регистра). */
export function heEngAdminRowMatches(row: HeEngAdminRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.email, row.full_name, row.company, row.project?.website_url, row.project?.name].some(
    (v) => typeof v === 'string' && v.toLowerCase().includes(q),
  );
}

export function emptyHeEngAdminCounts(): Record<HeEngAdminFilter, number> {
  return Object.fromEntries(HE_ENG_ADMIN_FILTERS.map((f) => [f, 0])) as Record<HeEngAdminFilter, number>;
}

/* ─────────────── Пул ─────────────── */

async function readPoolStrip(
  db: SupabaseClient,
  blockedProjectIds: ReadonlySet<string>,
): Promise<HeEngAdminPool> {
  let configured: string[] | null = null;
  try {
    configured = listInstantlyAccounts().map((a) => a.id);
  } catch {
    configured = null;
  }
  const workspace = readHeSendingPoolWorkspace(configured);
  const perProject = readHeSendingPoolSize().count;
  try {
    // До предела и ещё одной строки: она нашлась — строк больше предела.
    const read = await readCapped(HE_ENG_ADMIN_POOL_LIMIT + 1, (from, to) =>
      db
        .from(HE_SENDING_POOL_TABLE)
        .select('status, instantly_account_id, project_id')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    if ('error' in read) return isTableMissing(read.error) ? { state: 'missing' } : { state: 'error' };
    const limitReached = read.rows.length > HE_ENG_ADMIN_POOL_LIMIT;
    const rows = read.rows.slice(0, HE_ENG_ADMIN_POOL_LIMIT);
    let available = 0;
    let assigned = 0;
    let disabled = 0;
    const freeByWorkspace = new Map<string, number>();
    const heldProjects = new Set<string>();
    let heldMailboxes = 0;
    for (const r of rows) {
      const status = str(r.status);
      const ws = str(r.instantly_account_id);
      if (status === 'available') {
        available += 1;
        freeByWorkspace.set(ws, (freeByWorkspace.get(ws) ?? 0) + 1);
      } else if (status === 'assigned') {
        assigned += 1;
        const pid = str(r.project_id);
        if (pid && blockedProjectIds.has(pid)) {
          heldMailboxes += 1;
          heldProjects.add(pid);
        }
      } else if (status === 'disabled') {
        disabled += 1;
      }
    }
    // Выдача берёт ящики одного воркспейса из настроенных, кроме main
    // (heSendingPoolAssignableWorkspaces); окружение не прочиталось — все, кроме main.
    const assignable = configured
      ? new Set(heSendingPoolAssignableWorkspaces(configured))
      : new Set([...freeByWorkspace.keys()].filter((ws) => ws !== HE_SENDING_POOL_FORBIDDEN_WORKSPACE));
    let fits = 0;
    for (const [ws, free] of freeByWorkspace) if (assignable.has(ws)) fits += Math.floor(free / perProject);
    return {
      state: 'ok',
      workspace: workspace.id,
      workspace_problem: workspace.ok ? null : workspace.problem,
      available,
      assigned,
      disabled,
      per_project: perProject,
      fits_new_clients: fits,
      held_by_blocked: { mailboxes: heldMailboxes, projects: heldProjects.size },
      rows_read: rows.length,
      limit: HE_ENG_ADMIN_POOL_LIMIT,
      limit_reached: limitReached,
    };
  } catch {
    return { state: 'error' };
  }
}

/* ─────────────── Список ─────────────── */

export interface HeEngAdminListQuery {
  page?: number;
  perPage?: number;
  q?: string;
  filter?: HeEngAdminFilter;
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  }
  return out;
}

/**
 * Список раздела (см. шапку). { error } — любой сбой чтения БД (роут: 500
 * «Не удалось загрузить английских клиентов»). НЕ БРОСАЕТ.
 */
export async function readHeEngAdminList(
  db: SupabaseClient,
  query: HeEngAdminListQuery,
  deps: { auth: HeEngAdminAuthApi; now?: () => number },
): Promise<{ ok: true; list: HeEngAdminList } | { ok: false; detail: string }> {
  const clock = deps.now ?? (() => Date.now());
  const nowMs = clock();
  const perPage = Math.min(
    HE_ENG_ADMIN_PAGE_SIZE_MAX,
    Math.max(HE_ENG_ADMIN_PAGE_SIZE_MIN, Math.floor(query.perPage ?? HE_ENG_ADMIN_PAGE_SIZE) || HE_ENG_ADMIN_PAGE_SIZE),
  );
  const filter: HeEngAdminFilter = query.filter ?? 'all';

  let profiles: HeEngAdminProfile[];
  try {
    // Страницами по HE_ENG_ADMIN_PAGE_ROWS до предела и ещё одной строки
    // (она нашлась — профилей больше предела); id — второй ключ порядка, чтобы
    // страницы не перекрывались и не теряли строки с одинаковой датой.
    const read = await readCapped(HE_ENG_ADMIN_PROFILES_CAP + 1, (from, to) =>
      db
        .from('profiles')
        .select('id, email, full_name, company, created_at')
        .eq('role', 'client')
        .eq('market', 'eng')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
    );
    if ('error' in read) return { ok: false, detail: errText('profiles read', read.error) };
    profiles = read.rows
      .map((r) => ({
        id: str(r.id),
        email: strOrNull(r.email),
        full_name: strOrNull(r.full_name),
        company: strOrNull(r.company),
        created_at: strOrNull(r.created_at),
      }))
      .filter((p) => p.id.length > 0);
  } catch (e) {
    return { ok: false, detail: `profiles read threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
  const truncated = profiles.length > HE_ENG_ADMIN_PROFILES_CAP;
  if (truncated) profiles = profiles.slice(0, HE_ENG_ADMIN_PROFILES_CAP);
  const ids = profiles.map((p) => p.id);

  const [snapRead, authRead] = await Promise.all([
    readSnapshot(db, ids, nowMs),
    readAuthForAll(deps.auth, new Set(ids), clock),
  ]);
  if (!snapRead.ok) return { ok: false, detail: snapRead.detail };
  const s = snapRead.snapshot;

  const authOf = (id: string): HeEngAdminAuth => {
    const user = authRead.byId.get(id);
    if (user) return authViewOf(user, nowMs);
    return authRead.state === 'complete' ? { state: 'missing' } : { state: 'unread' };
  };

  let rows = profiles.map((p) => buildHeEngAdminRow(s, p, authOf(p.id)));
  const counts = emptyHeEngAdminCounts();
  for (const row of rows) for (const chip of row.chips) counts[chip] += 1;

  // Проекты аккаунтов с действующей блокировкой (отметка или бан) — для полосы пула.
  const blockedProjectIds = new Set<string>();
  for (const row of rows) {
    if (!row.chips.includes('blocked')) continue;
    for (const p of s.projectsByUser.get(row.user_id) ?? []) blockedProjectIds.add(str(p.id));
  }
  const pool = await readPoolStrip(db, blockedProjectIds);

  rows = sortHeEngAdminRows(rows.filter((r) => r.chips.includes(filter) && heEngAdminRowMatches(r, query.q ?? '')));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, Math.floor(query.page ?? 1) || 1));
  let pageRows = rows.slice((page - 1) * perPage, page * perPage);

  // Строки страницы без прочитанного бана — GoTrue по одному.
  const unreadOnPage = pageRows.filter((r) => r.auth.state === 'unread').map((r) => r.user_id);
  if (unreadOnPage.length > 0) {
    const fetched = new Map<string, HeEngAdminAuth>();
    await inBatches(unreadOnPage, AUTH_PAGE_CONCURRENCY, async (id) => {
      const res = await deps.auth.getUserById(id);
      if ('user' in res) fetched.set(id, authViewOf(res.user, nowMs));
      else if ('missing' in res) fetched.set(id, { state: 'missing' });
    });
    if (fetched.size > 0) {
      const byId = new Map(profiles.map((p) => [p.id, p]));
      pageRows = pageRows.map((r) => {
        const a = fetched.get(r.user_id);
        const profile = byId.get(r.user_id);
        return a && profile ? buildHeEngAdminRow(s, profile, a) : r;
      });
    }
  }

  return {
    ok: true,
    list: {
      total,
      page,
      per_page: perPage,
      truncated,
      profiles_cap: HE_ENG_ADMIN_PROFILES_CAP,
      counts,
      missing: snapRead.missing,
      auth: {
        state: authRead.state,
        pages: authRead.pages,
        users_read: authRead.usersRead,
        users_total: authRead.total,
        // Полное чтение не нашло аккаунт — его в GoTrue нет ('missing'), это не «не прочитан».
        unread_rows: authRead.state === 'complete' ? 0 : profiles.length - authRead.byId.size,
      },
      pool,
      rows: pageRows,
    },
  };
}

/* ─────────────── Карточка ─────────────── */

export interface HeEngAdminCampaign {
  campaign_id: string;
  name: string | null;
  segment: string | null;
  leads: number;
  status: number | null;
  status_read_at: string | null;
  sent: number | null;
  replies: number | null;
  counts_read_at: string | null;
  read_error: string | null;
  start_error: string | null;
}

export interface HeEngAdminMarket {
  vertical_id: string;
  name: string;
  rank: number | null;
  selected: boolean;
  template_id: string | null;
  template_status: string | null;
  launched_at: string | null;
  auto_launch: {
    state: HeEngAutoLaunchState;
    code: string | null;
    next_at: string | null;
    attempts: number;
    paid_failures: number;
    lease_live: boolean;
    updated_at: string | null;
  } | null;
  client_wish: { state: string; changed_at: string | null } | null;
  summary: HeEngSendingSummary | null;
  campaigns: HeEngAdminCampaign[];
}

export interface HeEngAdminCardProject {
  id: string;
  name: string | null;
  website_url: string | null;
  status: string;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  cancelled_at: string | null;
  autopilot: boolean;
  autopilot_error: string | null;
  autopilot_error_at: string | null;
  research_last_job: { stage: string; status: string; error: string | null; created_at: string | null; finished_at: string | null } | null;
  refill: { state: 'on' | 'off' | 'paused' | 'none'; paused_at: string | null; reason: string | null };
  active_jobs: Array<{ stage: string; status: string; created_at: string | null; started_at: string | null }>;
  intent: { wanted: boolean; requested_at: string | null; cancelled_at: string | null; settled_at: string | null } | null;
  markets: HeEngAdminMarket[];
}

/** Выключатель отправки — то же, что GET api/admin/users/[id]/eng-sending (view()). */
export interface HeEngAdminSendingView {
  applicable: boolean;
  required: boolean;
  state: 'enabled' | 'not_enabled' | 'revoked' | 'unavailable' | 'error';
  requested_at: string | null;
  enabled_at: string | null;
  revoked_at: string | null;
  email_sent_at: string | null;
}

export interface HeEngAdminCard {
  profile: HeEngAdminProfile & { signup_utm: unknown };
  auth: HeEngAdminAuth & { email_confirmed_at?: string | null; read_error?: true };
  marker: HeEngAdminMarkerState;
  block: {
    active: boolean;
    /**
     * Кто открыл эпизод: 'unblock' — «Разблокировать» у бана без отметки (оно
     * записало отметку перед своей остановкой) — тогда blocked_at — время того
     * нажатия, а sending_before / refill_enabled_before прочитаны перед его
     * остановкой; блокировки в разделе в начале эпизода не было.
     */
    opened_by: 'block' | 'unblock';
    blocked_at: string | null;
    last_block_at: string | null;
    unblocked_at: string | null;
    sending_before: string;
    refill_enabled_before: Record<string, string> | null;
    /** Отчёт последнего «Заблокировать» эпизода; null — его нет или он не читается. */
    last_stop: HeEngBlockReport | null;
    /**
     * Что из остановки блокировки, которая действует сейчас, не подтверждено
     * (heEngLastStopDoubt) — одна фраза для вопроса перед «Разблокировать»; у
     * снятой и у подтверждённой — null (разблокировка снимает бан только после
     * подтверждённой остановки, engAccountBlock). У эпизода, который открыло
     * «Разблокировать», без отчёта «Заблокировать» — тоже null: что не
     * остановилось тогда, сказал ответ того нажатия (вопрос называет его сам).
     */
    stop_doubt: string | null;
  } | null;
  ban_without_stop: boolean;
  marker_without_ban: boolean;
  verification: { state: HeEngAdminVerification; email: string | null; verified_at: string | null; last_sent_at: string | null };
  sending: HeEngAdminSendingView;
  projects: HeEngAdminCardProject[];
  /** he_projects аккаунта любого рынка: удалить аккаунт можно только без них (сторож DELETE). null — не прочитано. */
  projects_total: number | null;
  mailboxes: Array<{ email: string; workspace: string; assigned_at: string | null; project_id: string }> | null;
  spend: { state: 'ok'; known_usd: number; unpriced_calls: number; calls: number; lost_rows: number } | { state: 'timeout' | 'failed' };
  client_emails: Array<{
    kind: string;
    code: string | null;
    next_step: string | null;
    created_at: string | null;
    sent_at: string | null;
    attempts: number;
    closed_at: string | null;
  }> | null;
  support: { thread_id: string; last_message_at: string | null; last_message_role: string | null } | null;
  leak: HeEngAdminLeak[];
  attention: HeEngAdminAttention[];
  missing: HeEngAdminSource[];
  /** Строка списка этого аккаунта (те же правила чипов). */
  row: HeEngAdminRow;
}

/**
 * Выключатель для карточки — те же поля, что view() роута eng-sending
 * (состояние строки без снятия требования env). Сбой чтения сюда не доходит:
 * он роняет всю карточку (500). Таблицы нет — 'unavailable'.
 */
function sendingViewOf(row: Row | null, available: boolean): HeEngAdminSendingView {
  const base = {
    applicable: true,
    required: heEngSendingActivationRequired(),
    requested_at: strOrNull(row?.requested_at),
    enabled_at: strOrNull(row?.enabled_at),
    revoked_at: strOrNull(row?.revoked_at),
    email_sent_at: strOrNull(row?.email_sent_at),
  };
  const state = sendingStateOf(row, available);
  return { ...base, state: state === 'missing' ? 'unavailable' : state };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type HeEngAdminCardRead =
  | { ok: true; card: HeEngAdminCard }
  | { ok: false; kind: 'not_eng_client' }
  | { ok: false; kind: 'error'; detail: string };

/**
 * Карточка клиента. 'not_eng_client' — профиля нет или он не client + eng
 * (роут: 404 «Это не клиент английского кабинета»). Сбой чтения БД —
 * 'error' (500). GoTrue не ответил — карточка с `auth.state 'unread'`
 * («статус не прочитан», никогда «Активен»). Расход — не дольше
 * HE_ENG_ADMIN_SPEND_TIMEOUT_MS, иначе «не посчитан». НЕ БРОСАЕТ.
 */
export async function readHeEngAdminCard(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  userId: string,
  deps: { auth: HeEngAdminAuthApi; refresh: boolean; now?: () => number },
): Promise<HeEngAdminCardRead> {
  const nowMs = (deps.now ?? (() => Date.now()))();
  try {
    const { data: profileRow, error: profileErr } = await db
      .from('profiles')
      .select('id, email, full_name, company, created_at, role, market, signup_utm')
      .eq('id', userId)
      .maybeSingle();
    if (profileErr) return { ok: false, kind: 'error', detail: errText('profiles read', profileErr) };
    const p = (profileRow ?? null) as Row | null;
    if (!p || p.role !== 'client' || p.market !== 'eng') return { ok: false, kind: 'not_eng_client' };
    const profile = {
      id: str(p.id),
      email: strOrNull(p.email),
      full_name: strOrNull(p.full_name),
      company: strOrNull(p.company),
      created_at: strOrNull(p.created_at),
      signup_utm: p.signup_utm ?? null,
    };

    const [snapRead, authRes, rowsRead] = await Promise.all([
      readSnapshot(db, [userId], nowMs),
      deps.auth.getUserById(userId),
      readHeEngAccountBlockRows(db, [userId], { withReport: true }),
    ]);
    if (!snapRead.ok) return { ok: false, kind: 'error', detail: snapRead.detail };
    if (rowsRead.state === 'error') return { ok: false, kind: 'error', detail: rowsRead.detail };
    const s = snapRead.snapshot;
    const auth: HeEngAdminCard['auth'] =
      'user' in authRes
        ? { ...authViewOf(authRes.user, nowMs), email_confirmed_at: authRes.user.email_confirmed_at }
        : 'missing' in authRes
          ? { state: 'missing' }
          : { state: 'unread', read_error: true };
    const row = buildHeEngAdminRow(s, profile, auth);
    const markerRow = rowsRead.state === 'ok' ? rowsRead.rows.get(userId) ?? null : null;

    const projectRows = [...(s.projectsByUser.get(userId) ?? [])].sort((a, b) => tsOf(b.created_at) - tsOf(a.created_at));
    const pids = projectRows.map((r) => str(r.id));

    // Карточные чтения: вертикали с именами, шаблоны с launch_info, желание
    // клиента, последняя research-джоба, письма клиенту, все проекты аккаунта.
    const vertTpl = (async (): Promise<{ verticals: SourceRead; templates: SourceRead }> => {
      const verticals = await readByIds('he_verticals', pids, (part, from, to) =>
        db
          .from('he_verticals')
          .select('id, project_id, name, rank')
          .in('project_id', part)
          .order('id', { ascending: true })
          .range(from, to),
      );
      if (verticals.state !== 'ok') return { verticals, templates: verticals };
      const templates = await readByIds(
        'he_templates',
        verticals.rows.map((v) => str(v.id)),
        (part, from, to) =>
          db
            .from('he_templates')
            .select('id, vertical_id, status, launch_info, created_at')
            .in('vertical_id', part)
            .order('id', { ascending: true })
            .range(from, to),
      );
      return { verticals, templates };
    })();
    const [{ verticals: vertRead, templates: tplRead }, researchRead, emailsRes, allProjectsRes] = await Promise.all([
      vertTpl,
      readByIds('he_jobs research', pids, (part, from, to) =>
        db
          .from('he_jobs')
          .select('project_id, stage, status, error, created_at, finished_at')
          .in('project_id', part)
          .in('stage', HE_RESEARCH_STAGES)
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      (async () => {
        try {
          return await db
            .from('he_eng_client_emails')
            .select('kind, code, next_step, created_at, sent_at, attempts, closed_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(CLIENT_EMAILS_LIMIT);
        } catch (e) {
          return { data: null, error: { code: null, message: e instanceof Error ? e.message : 'threw' } };
        }
      })(),
      (async () => {
        try {
          return await db.from('he_projects').select('id', { count: 'exact', head: true }).eq('created_by', userId);
        } catch {
          return { count: null, error: { code: null, message: 'threw' } };
        }
      })(),
    ]);
    if (vertRead.state !== 'ok') return { ok: false, kind: 'error', detail: vertRead.state === 'error' ? vertRead.detail : 'he_verticals missing' };
    if (tplRead.state !== 'ok') return { ok: false, kind: 'error', detail: tplRead.state === 'error' ? tplRead.detail : 'he_templates missing' };
    if (researchRead.state !== 'ok') return { ok: false, kind: 'error', detail: researchRead.state === 'error' ? researchRead.detail : 'he_jobs missing' };
    let clientEmails: HeEngAdminCard['client_emails'] = null;
    if (emailsRes.error) {
      if (!isTableMissing(emailsRes.error)) return { ok: false, kind: 'error', detail: errText('he_eng_client_emails read', emailsRes.error) };
    } else {
      clientEmails = ((emailsRes.data ?? []) as Row[]).map((r) => ({
        kind: str(r.kind),
        code: strOrNull(r.code),
        next_step: strOrNull(r.next_step),
        created_at: strOrNull(r.created_at),
        sent_at: strOrNull(r.sent_at),
        attempts: numOrNull(r.attempts) ?? 0,
        closed_at: strOrNull(r.closed_at),
      }));
    }
    const projectsTotal = allProjectsRes.error ? null : typeof allProjectsRes.count === 'number' ? allProjectsRes.count : null;

    const templates = tplRead.rows;
    const templatesByVertical = groupBy(templates, 'vertical_id');
    const launchRefs: HeEngLaunchRef[] = [];
    const launchedByVertical = new Map<string, { templateId: string; launch: HeTemplateLaunchInfo }>();
    for (const v of vertRead.rows) {
      const vid = str(v.id);
      const launched = engDashLaunchedTemplate(templatesByVertical.get(vid) ?? []);
      if (!launched) continue;
      launchedByVertical.set(vid, launched);
      launchRefs.push({ projectId: str(v.project_id), templateId: launched.templateId, launch: launched.launch });
    }

    // Желание клиента и сводки отправки (кэш; refresh — фоновое живое чтение).
    const [wishRead, summaries] = await Promise.all([
      readByIds('he_eng_launch_sending', launchRefs.map((l) => l.templateId), (part, from, to) =>
        db
          .from('he_eng_launch_sending')
          .select('template_id, client_state, changed_at')
          .in('template_id', part)
          .order('template_id', { ascending: true })
          .range(from, to),
      ),
      readHeEngSendingSummaries(db, instantlyDb, { userId, launches: launchRefs, refresh: deps.refresh, now: nowMs }),
    ]);
    if (wishRead.state === 'error') return { ok: false, kind: 'error', detail: wishRead.detail };
    const wishes = wishRead.state === 'ok' ? indexBy(wishRead.rows, 'template_id') : new Map<string, Row>();
    const cacheByCampaign = new Map<string, Row>();
    for (const pid of pids) for (const c of s.campaigns?.get(pid) ?? []) cacheByCampaign.set(str(c.campaign_id), c);
    const autoByTemplate = new Map<string, Row>();
    for (const pid of pids) for (const r of s.autoRows?.get(pid) ?? []) autoByTemplate.set(str(r.template_id), r);

    const researchByProject = new Map<string, Row>();
    for (const j of researchRead.rows) {
      const pid = str(j.project_id);
      if (!researchByProject.has(pid)) researchByProject.set(pid, j);
    }

    const projects: HeEngAdminCardProject[] = projectRows.map((pr) => {
      const pid = str(pr.id);
      const selected = new Set(s.selected.get(pid) ?? []);
      const verticals = vertRead.rows
        .filter((v) => str(v.project_id) === pid)
        .filter((v) => selected.has(str(v.id)) || launchedByVertical.has(str(v.id)) || (templatesByVertical.get(str(v.id)) ?? []).length > 0)
        .sort((a, b) => (numOrNull(a.rank) ?? 1e9) - (numOrNull(b.rank) ?? 1e9));
      const markets: HeEngAdminMarket[] = verticals.map((v) => {
        const vid = str(v.id);
        const launched = launchedByVertical.get(vid) ?? null;
        const tpls = [...(templatesByVertical.get(vid) ?? [])].sort((a, b) => tsOf(b.created_at) - tsOf(a.created_at));
        const tpl = launched ? tpls.find((t) => str(t.id) === launched.templateId) ?? null : tpls[0] ?? null;
        const templateId = tpl ? str(tpl.id) : null;
        const al = templateId ? autoByTemplate.get(templateId) ?? null : null;
        const wish = templateId ? wishes.get(templateId) ?? null : null;
        const campaigns: HeEngAdminCampaign[] = [];
        if (launched) {
          const list = launched.launch.campaigns ?? [
            {
              campaign_id: launched.launch.campaign_id,
              campaign_name: launched.launch.campaign_name,
              campaign_url: launched.launch.campaign_url,
              segment: null,
              leads_count: launched.launch.leads_count,
            },
          ];
          for (const c of list) {
            const cache = cacheByCampaign.get(c.campaign_id) ?? null;
            campaigns.push({
              campaign_id: c.campaign_id,
              name: c.campaign_name || null,
              segment: c.segment ?? null,
              leads: c.leads_count,
              status: numOrNull(cache?.status),
              status_read_at: strOrNull(cache?.status_read_at),
              sent: numOrNull(cache?.sent),
              replies: numOrNull(cache?.replies),
              counts_read_at: strOrNull(cache?.counts_read_at),
              read_error: strOrNull(cache?.read_error),
              start_error: strOrNull(cache?.start_error),
            });
          }
        }
        return {
          vertical_id: vid,
          name: str(v.name),
          rank: numOrNull(v.rank),
          selected: selected.has(vid),
          template_id: templateId,
          template_status: tpl ? strOrNull(tpl.status) : null,
          launched_at: launched ? strOrNull(launched.launch.created_at) : null,
          auto_launch: al
            ? {
                state: str(al.state) as HeEngAutoLaunchState,
                code: strOrNull(al.code),
                next_at: strOrNull(al.next_at),
                attempts: numOrNull(al.attempts) ?? 0,
                paid_failures: numOrNull(al.paid_failures) ?? 0,
                lease_live: str(al.state) === 'running' && tsOf(al.lease_until) > nowMs,
                updated_at: strOrNull(al.updated_at),
              }
            : null,
          client_wish: wish ? { state: str(wish.client_state), changed_at: strOrNull(wish.changed_at) } : null,
          summary: launched ? summaries.get(launched.templateId) ?? null : null,
          campaigns,
        };
      });
      const cfg = s.refill.get(pid);
      const intent = s.intents?.get(pid) ?? null;
      const research = researchByProject.get(pid) ?? null;
      return {
        id: pid,
        name: strOrNull(pr.name),
        website_url: strOrNull(pr.website_url),
        status: str(pr.status),
        error: strOrNull(pr.error),
        created_at: strOrNull(pr.created_at),
        updated_at: strOrNull(pr.updated_at),
        cancelled_at: strOrNull(pr.cancelled_at),
        autopilot: pr.autopilot === true,
        autopilot_error: strOrNull(pr.autopilot_error),
        autopilot_error_at: strOrNull(pr.autopilot_error_at),
        research_last_job: research
          ? {
              stage: str(research.stage),
              status: str(research.status),
              error: strOrNull(research.error),
              created_at: strOrNull(research.created_at),
              finished_at: strOrNull(research.finished_at),
            }
          : null,
        refill: cfg
          ? {
              state: cfg.enabled !== true ? 'off' : strOrNull(cfg.refill_paused_at) ? 'paused' : 'on',
              paused_at: strOrNull(cfg.refill_paused_at),
              reason: strOrNull(cfg.refill_pause_reason),
            }
          : { state: 'none', paused_at: null, reason: null },
        active_jobs: (s.activeJobs.get(pid) ?? []).map((j) => ({
          stage: str(j.stage),
          status: str(j.status),
          created_at: strOrNull(j.created_at),
          started_at: strOrNull(j.started_at),
        })),
        intent: intent
          ? {
              wanted: intent.wanted === true,
              requested_at: strOrNull(intent.requested_at),
              cancelled_at: strOrNull(intent.cancelled_at),
              settled_at: strOrNull(intent.settled_at),
            }
          : null,
        markets,
      };
    });

    const mailboxes =
      s.mailboxes === null
        ? null
        : pids.flatMap((pid) =>
            (s.mailboxes?.get(pid) ?? []).map((m) => ({
              email: str(m.email),
              workspace: str(m.instantly_account_id),
              assigned_at: strOrNull(m.assigned_at),
              project_id: pid,
            })),
          );

    // Расход — нижняя граница, не дольше HE_ENG_ADMIN_SPEND_TIMEOUT_MS.
    let spend: HeEngAdminCard['spend'];
    const spent = await withTimeout(
      readHeClientProviderSpend(db, { userId, serperUsdPer1000: readHeSpendCaps().serperUsdPer1000 }).then(
        (v) => ({ ok: true as const, v }),
        () => ({ ok: false as const }),
      ),
      HE_ENG_ADMIN_SPEND_TIMEOUT_MS,
    );
    if (spent === 'timeout') spend = { state: 'timeout' };
    else if (!spent.ok) spend = { state: 'failed' };
    else spend = { state: 'ok', known_usd: spent.v.knownUsd, unpriced_calls: spent.v.unpricedCalls, calls: spent.v.calls, lost_rows: spent.v.lostRows };

    const thread = s.threads.get(userId) ?? null;
    const verifRow = s.verifications?.get(userId) ?? null;
    return {
      ok: true,
      card: {
        profile,
        auth,
        marker: row.marker,
        block: markerRow
          ? {
              active: markerRow.active,
              opened_by: markerRow.openedBy ?? 'block',
              blocked_at: markerRow.blockedAt || null,
              last_block_at: markerRow.lastBlockAt || null,
              unblocked_at: markerRow.unblockedAt,
              sending_before: markerRow.sendingBefore,
              refill_enabled_before: markerRow.refillEnabledBefore,
              last_stop: markerRow.lastStop ?? null,
              stop_doubt:
                markerRow.active && !(markerRow.openedBy === 'unblock' && !markerRow.lastStop)
                  ? heEngAdminStopDoubtText(markerRow.lastStop ?? null)
                  : null,
            }
          : null,
        ban_without_stop: row.ban_without_stop,
        marker_without_ban: row.marker_without_ban,
        verification: {
          state: row.email_verified,
          email: strOrNull(verifRow?.email),
          verified_at: strOrNull(verifRow?.verified_at),
          last_sent_at: strOrNull(verifRow?.last_sent_at),
        },
        sending: sendingViewOf(s.access?.get(userId) ?? null, s.access !== null),
        projects,
        projects_total: projectsTotal,
        mailboxes,
        spend,
        client_emails: clientEmails,
        support: thread
          ? { thread_id: str(thread.id), last_message_at: strOrNull(thread.last_message_at), last_message_role: strOrNull(thread.last_message_role) }
          : null,
        leak: row.leak,
        attention: row.attention,
        missing: snapRead.missing,
        row,
      },
    };
  } catch (e) {
    return { ok: false, kind: 'error', detail: `card read threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}
