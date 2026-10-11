/**
 * ENG: пул НАШИХ ящиков отправки (решение владельца 10–11.10.2026).
 *
 * Клиент ENG ящики не подключает. Каждый us-проект получает из пула
 * HE_US_POOL_MAILBOXES_PER_PROJECT ящиков (по умолчанию 3) из ОДНОГО воркспейса
 * рассыльщика, и они принадлежат только ему. Таблица he_sending_pool и функции
 * выдачи / возврата / смены статуса — миграция 20261011_0001 (её шапка —
 * переходы состояний, правило закрепления воркспейса и ответы функций). Здесь —
 * обёртки, которые НИКОГДА не бросают и переводят ответ функции в
 * типизированный результат, плюс алерт команде.
 *
 * ЧТО ЗДЕСЬ И ДЛЯ КОГО.
 *  - assignHeSendingPool — выдача; зовёт engSendingPreset.ensureHeEngPresetForProject
 *    (её контракт для роута запуска — в шапке того файла);
 *  - readHeSendingPoolAssignment + checkHeCampaignAgainstAssignment — только
 *    чтение, ничего не выдают: проверка живой кампании перед активацией и
 *    Resume (пункт 4 того же контракта);
 *  - findHeSendingPoolMailboxUses — только чтение БД рассыльщика: стоит ли
 *    адрес в пресете или живом запуске RU-кабинета другого клиента; зовут
 *    ensureHeEngPresetForProject (после выдачи), «Start sending» / «Resume»
 *    (engCampaignSending.startHeEngLaunchSending), проверка ночного долива
 *    (autoPipeline.createHeRefillSendGate) и staff-роуты добавления и
 *    включения ящика;
 *  - releaseHeSendingPool, setHeSendingPoolMailboxStatus,
 *    checkHeSendingPoolMailboxAtProvider — staff-роуты
 *    api/tools/hypothesis-engine/sending-pool/** и
 *    api/tools/hypothesis-engine/projects/[id]/sending-pool;
 *  - notifyHeSendingPool — алерт команде (ниже).
 * RU-кабинет, RU staff-запуск и verticalEngineV2 пул не читают и не пишут.
 *
 * МИГРАЦИЯ НЕ ПРИМЕНЕНА (нет функции 42883 / PGRST202, нет таблицы 42P01 /
 * PGRST205) — каждая обёртка отвечает kind 'unavailable': выдачи нет, и
 * ensureHeEngPresetForProject отвечает ошибкой 503 (пресет не пишется — запуск,
 * который её зовёт, отказывает: fail-closed для отправки); экран сотрудника
 * пишет «миграция не применена».
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { getAccount } from '@/lib/instantly/client';
import { InstantlyApiError } from '@/lib/instantly/errors';
import { AccountStatus, AccountStatusLabels, WarmupStatusLabels } from '@/lib/instantly/types';
import { logWarn } from '@/lib/loggerServer';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';
import { HE_OPS_SEND_TIMEOUT_MS, HE_OPS_TEAM_FIX_REPEAT_MS, heOpsReasonText } from './opsAlert';

export const HE_SENDING_POOL_TABLE = 'he_sending_pool';
const ASSIGN_RPC = 'he_sending_pool_assign';
const RELEASE_RPC = 'he_sending_pool_release';
const SET_STATUS_RPC = 'he_sending_pool_set_status';

/* ─────────────── Сколько ящиков на проект ─────────────── */

export const HE_US_POOL_MAILBOXES_PER_PROJECT_ENV = 'HE_US_POOL_MAILBOXES_PER_PROJECT';
export const HE_US_POOL_MAILBOXES_PER_PROJECT_DEFAULT = 3;
/** Потолок значения env (функция выдачи принимает до 50 — запас под ручной вызов). */
export const HE_US_POOL_MAILBOXES_PER_PROJECT_MAX = 20;

/**
 * Целое 1..HE_US_POOL_MAILBOXES_PER_PROJECT_MAX; пусто — дефолт; мусор, 0,
 * дробь, больше потолка — дефолт и rejected (строка warn у вызывающего).
 * Число действует при ПЕРВОЙ выдаче проекту: у проекта с ящиками функция
 * возвращает уже отданные, сколько бы их ни было.
 */
export function readHeSendingPoolSize(env: NodeJS.ProcessEnv = process.env): { count: number; rejected: boolean } {
  const text = (env[HE_US_POOL_MAILBOXES_PER_PROJECT_ENV] ?? '').trim();
  if (!text) return { count: HE_US_POOL_MAILBOXES_PER_PROJECT_DEFAULT, rejected: false };
  const value = Number(text);
  if (Number.isSafeInteger(value) && value >= 1 && value <= HE_US_POOL_MAILBOXES_PER_PROJECT_MAX) {
    return { count: value, rejected: false };
  }
  return { count: HE_US_POOL_MAILBOXES_PER_PROJECT_DEFAULT, rejected: true };
}

/* ─────────────── Строка пула ─────────────── */

export type HeSendingPoolStatus = 'available' | 'assigned' | 'disabled';

export interface HeSendingPoolRow {
  id: string;
  email: string;
  instantly_account_id: string;
  status: HeSendingPoolStatus;
  project_id: string | null;
  assigned_at: string | null;
  released_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface HeSendingPoolMailbox {
  id: string;
  email: string;
}

const EMAIL_MAX = 254;
// Без запятых, скобок и кавычек: адрес уходит в список ящиков пресета и
// кампании и в путь GET /accounts/{email} у рассыльщика.
const EMAIL_RE = /^[^\s@,;:<>()[\]{}"'\\]+@[^\s@,;:<>()[\]{}"'\\]+\.[^\s@,;:<>()[\]{}"'\\]+$/;

/** Адрес ящика пула: обрезан, в нижнем регистре, похож на адрес — иначе null. */
export function normalizeHeSendingPoolEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return null;
  return email;
}

/* ─────────────── Отказы БД ─────────────── */

interface PgError {
  code?: string | null;
  message?: string | null;
}

/** Миграция 20261011_0001 не применена: нет функции или таблицы. */
function isPoolMissing(error: PgError | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42883' || code === 'PGRST202' || code === '42P01' || code === 'PGRST205';
}

function errorText(prefix: string, error: PgError | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

const POOL_MISSING_REASON = 'he_sending_pool is missing (migration 20261011_0001 not applied)';

/** Одна строка warn на причину в окно: выдачу зовёт каждый запуск. */
const DEGRADED_LOG_WINDOW_MS = 10 * 60 * 1000;
const degradedLoggedAt = new Map<string, number>();

function warnDegraded(key: string, message: string, context: Record<string, unknown>): void {
  const now = Date.now();
  if (now - (degradedLoggedAt.get(key) ?? 0) < DEGRADED_LOG_WINDOW_MS) return;
  if (degradedLoggedAt.size >= 100) degradedLoggedAt.clear();
  degradedLoggedAt.set(key, now);
  void logWarn('he.sending_pool.degraded', message, context);
}

type RpcCall =
  | { kind: 'answer'; answer: Record<string, unknown> }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Вызов функции пула. НЕ БРОСАЕТ. Ошибка Postgres откатывает функцию целиком
 * (она — одна транзакция): ни одного ящика не отдано, не возвращено, не
 * выключено. Ответ, потерянный транспортом ПОСЛЕ коммита, оставляет сделанное —
 * повтор выдачи вернёт те же ящики (выдача идемпотентна по проекту).
 */
async function callPoolRpc(db: SupabaseClient, rpc: string, args: Record<string, unknown>): Promise<RpcCall> {
  try {
    const { data, error } = await db.rpc(rpc, args);
    if (error) {
      if (isPoolMissing(error)) {
        warnDegraded(`${rpc}_missing`, `${rpc}: ${POOL_MISSING_REASON}`, { rpc });
        return { kind: 'unavailable' };
      }
      return { kind: 'error', message: errorText(`${rpc} rpc`, error) };
    }
    const answer = asObject(data);
    if (answer && typeof answer.outcome === 'string') return { kind: 'answer', answer };
    return { kind: 'error', message: `${rpc}: unexpected answer` };
  } catch (e) {
    return { kind: 'error', message: `${rpc} threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function asMailboxes(value: unknown): HeSendingPoolMailbox[] | null {
  if (!Array.isArray(value)) return null;
  const out: HeSendingPoolMailbox[] = [];
  for (const item of value) {
    const row = asObject(item);
    const id = asText(row?.id);
    const email = asText(row?.email);
    if (!id || !email) return null;
    out.push({ id, email });
  }
  return out;
}

/* ─────────────── Выдача ─────────────── */

/** Причины конфликта воркспейса — дословно из функции выдачи (шапка миграции). */
export type HeSendingPoolConflictReason = 'mixed' | 'unconfigured' | 'preset_pinned' | 'preset_missing';

export type HeSendingPoolAssignResult =
  /**
   * Ящики проекта (уже отданные или выданные этим вызовом). `newlyAssigned` —
   * сколько выдано сейчас (0 — повтор); `freeLeft` — сколько свободных осталось
   * в воркспейсе после выдачи (null у повтора).
   */
  | {
      kind: 'assigned';
      instantlyAccountId: string;
      mailboxes: HeSendingPoolMailbox[];
      newlyAssigned: number;
      freeLeft: number | null;
    }
  /** Свободных в одном годном воркспейсе меньше `need` — НЕ отдано ничего. */
  | {
      kind: 'shortage';
      need: number;
      bestFree: number;
      pinnedWorkspace: string | null;
      byWorkspace: Record<string, number>;
    }
  /** Ничего не отдано и не изменено — разбирает сотрудник. */
  | {
      kind: 'workspace_conflict';
      reason: HeSendingPoolConflictReason;
      instantlyAccountId: string | null;
      presetWorkspace: string | null;
    }
  | { kind: 'not_found' }
  | { kind: 'not_us' }
  /** Миграция не применена. */
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

const CONFLICT_REASONS: ReadonlySet<string> = new Set(['mixed', 'unconfigured', 'preset_pinned', 'preset_missing']);

/**
 * Выдать проекту ящики (he_sending_pool_assign). `workspaces` — воркспейсы,
 * которые код знает (listInstantlyAccounts); `presetWorkspace` — воркспейс
 * текущего пресета клиента или null, если пресета нет (правило закрепления —
 * шапка миграции).
 */
export async function assignHeSendingPool(
  db: SupabaseClient,
  args: { projectId: string; count: number; workspaces: string[]; presetWorkspace: string | null },
): Promise<HeSendingPoolAssignResult> {
  const call = await callPoolRpc(db, ASSIGN_RPC, {
    p_project_id: args.projectId,
    p_count: args.count,
    p_workspaces: args.workspaces,
    p_preset_workspace: args.presetWorkspace,
  });
  if (call.kind !== 'answer') return call;
  const a = call.answer;
  switch (a.outcome) {
    case 'assigned': {
      const instantlyAccountId = asText(a.instantly_account_id);
      const mailboxes = asMailboxes(a.mailboxes);
      const newlyAssigned = asCount(a.newly_assigned);
      if (!instantlyAccountId || !mailboxes || mailboxes.length === 0 || newlyAssigned === null) {
        return { kind: 'error', message: `${ASSIGN_RPC}: malformed assigned answer` };
      }
      return { kind: 'assigned', instantlyAccountId, mailboxes, newlyAssigned, freeLeft: asCount(a.free_left) };
    }
    case 'shortage': {
      const byWorkspace: Record<string, number> = {};
      for (const [ws, free] of Object.entries(asObject(a.by_workspace) ?? {})) {
        const n = asCount(free);
        if (n !== null) byWorkspace[ws] = n;
      }
      return {
        kind: 'shortage',
        need: asCount(a.need) ?? args.count,
        bestFree: asCount(a.best_free) ?? 0,
        pinnedWorkspace: asText(a.pinned_workspace),
        byWorkspace,
      };
    }
    case 'workspace_conflict': {
      const reason = typeof a.reason === 'string' && CONFLICT_REASONS.has(a.reason) ? a.reason : null;
      if (!reason) return { kind: 'error', message: `${ASSIGN_RPC}: unknown conflict reason` };
      return {
        kind: 'workspace_conflict',
        reason: reason as HeSendingPoolConflictReason,
        instantlyAccountId: asText(a.instantly_account_id),
        presetWorkspace: asText(a.preset_workspace),
      };
    }
    case 'not_found':
      return { kind: 'not_found' };
    case 'not_us':
      return { kind: 'not_us' };
    default:
      return { kind: 'error', message: `${ASSIGN_RPC}: unexpected outcome ${String(a.outcome).slice(0, 40)}` };
  }
}

/* ─────────────── Только чтение: ящики проекта ─────────────── */

export type HeSendingPoolAssignment =
  /** Ящики проекта — все в одном воркспейсе; адреса в нижнем регистре, по алфавиту. */
  | { kind: 'assigned'; instantlyAccountId: string; emails: string[] }
  /** У проекта нет отданных ящиков. */
  | { kind: 'none' }
  /** Ящики проекта в разных воркспейсах — так быть не должно (руками), отправлять нельзя. */
  | { kind: 'mixed'; workspaces: string[] }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * Что отдано проекту — БЕЗ выдачи. Для проверки перед активацией и Resume:
 * адреса кампании у рассыльщика (email_list) обязаны входить в этот набор, а
 * воркспейс — совпадать (пресет мог поправить администратор, кампании —
 * сотрудник у рассыльщика). Не бросает.
 */
export async function readHeSendingPoolAssignment(
  db: SupabaseClient,
  projectId: string,
): Promise<HeSendingPoolAssignment> {
  try {
    const { data, error } = await db
      .from(HE_SENDING_POOL_TABLE)
      .select('email, instantly_account_id')
      .eq('project_id', projectId)
      .eq('status', 'assigned')
      .limit(HE_US_POOL_MAILBOXES_PER_PROJECT_MAX * 3);
    if (error) {
      if (isPoolMissing(error)) {
        warnDegraded('read_missing', `assignment read: ${POOL_MISSING_REASON}`, { projectId });
        return { kind: 'unavailable' };
      }
      return { kind: 'error', message: errorText('he_sending_pool read', error) };
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ email?: unknown; instantly_account_id?: unknown }>;
    if (rows.length === 0) return { kind: 'none' };
    const workspaces = [...new Set(rows.map((r) => String(r.instantly_account_id ?? '')))].sort();
    if (workspaces.length !== 1 || !workspaces[0]) return { kind: 'mixed', workspaces };
    const emails = [...new Set(rows.map((r) => String(r.email ?? '')).filter(Boolean))].sort();
    return { kind: 'assigned', instantlyAccountId: workspaces[0], emails };
  } catch (e) {
    return { kind: 'error', message: `he_sending_pool read threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}

export type HeCampaignAssignmentCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       * workspace_mismatch — кампания в другом воркспейсе, чем ящики проекта;
       * no_mailboxes — в кампании нет ни одного ящика (она не отправит ничего);
       * foreign_mailbox — в кампании есть ящик, который проекту НЕ отдан
       * (поправленный пресет, ручная правка у рассыльщика, запуск сотрудника
       * с чужим пресетом).
       */
      reason: 'workspace_mismatch' | 'no_mailboxes' | 'foreign_mailbox';
      foreign: string[];
    };

/**
 * Живая кампания против ящиков проекта (readHeSendingPoolAssignment, kind
 * 'assigned'): тот же воркспейс, непустой email_list, и КАЖДЫЙ его адрес —
 * ящик проекта (подмножество, а не равенство: кампании, созданные до того,
 * как проекту добавили ящик, его не содержат). Адреса сравниваются без
 * регистра и пробелов, воркспейсы — после resolveInstantlyAccountId.
 * Чистая функция: рассыльщика читает вызывающий.
 */
export function checkHeCampaignAgainstAssignment(
  assignment: Extract<HeSendingPoolAssignment, { kind: 'assigned' }>,
  campaign: { instantlyAccountId: string | null | undefined; emailList: unknown },
): HeCampaignAssignmentCheck {
  if (resolveInstantlyAccountId(campaign.instantlyAccountId) !== resolveInstantlyAccountId(assignment.instantlyAccountId)) {
    return { ok: false, reason: 'workspace_mismatch', foreign: [] };
  }
  const list = Array.isArray(campaign.emailList)
    ? campaign.emailList.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')).filter(Boolean)
    : [];
  if (list.length === 0) return { ok: false, reason: 'no_mailboxes', foreign: [] };
  const own = new Set(assignment.emails.map((e) => e.trim().toLowerCase()));
  const foreign = [...new Set(list.filter((e) => !own.has(e)))];
  if (foreign.length > 0) return { ok: false, reason: 'foreign_mailbox', foreign };
  return { ok: true };
}

/* ─────────────── Ящик пула вне пула: пресеты и запуски клиентов ─────────────── */

/**
 * Где ещё стоит адрес (БД рассыльщика, только чтение, без рассыльщика):
 *  - 'preset' — client_campaign_presets.email_account_ids любого клиента. Из
 *    ЕДИНСТВЕННОГО пресета клиента создают кампании RU-кабинет (runLaunch),
 *    его авто-конвейер, staff-запуск движка, VE2 и ENG;
 *  - 'launch' — client_campaign_launches.email_account_ids (журнал запусков
 *    RU-кабинета) у строк в статусах uploading / active / paused (те же
 *    статусы, что берёт синхронизация пресета администратора), с кампанией
 *    или ещё без неё: подмножество ящиков пресета, выбранное клиентом на
 *    запуск, остаётся в кампании, даже когда его убрали из пресета. Строка с
 *    NULL — кампания на всём пресете (её покрывает 'preset' — пока адрес в
 *    пресете).
 * Чего здесь НЕТ: кампаний, созданных у рассыльщика руками или
 * staff-инструментом кампаний (по тегу ящиков или списку — каталог список
 * ящиков не хранит, знает только рассыльщик); адресов, которые убрали из
 * пресета, а кампании RU / VE2 / ENG, созданные раньше, их держат (VE2
 * хранит снимок ящиков в своей таблице, но ENG её не читает — движки
 * независимы); запусков RU в статусах failed / completed.
 */
export type HeSendingPoolMailboxUse =
  | { source: 'preset'; email: string; clientUserId: string }
  | { source: 'launch'; email: string; clientUserId: string; campaignId: string | null; status: string };

export type HeSendingPoolMailboxUses =
  | { kind: 'free' }
  /** До USES_MAX находок — для текста сотруднику и алерта. */
  | { kind: 'in_use'; uses: HeSendingPoolMailboxUse[] }
  | { kind: 'error'; message: string };

const LIVE_LAUNCH_STATUSES = ['uploading', 'active', 'paused'];
const USES_MAX = 10;
const SCAN_PAGE = 1000;
const SCAN_MAX_PAGES = 50;

function normalizeMailboxAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Прочитать таблицу целиком страницами по id (после последнего id страницы —
 * не по смещению: короткая страница от лимита строк PostgREST не теряет
 * строки) до пустой страницы. Больше SCAN_PAGE × SCAN_MAX_PAGES строк —
 * ошибка, а не «просмотрено частично».
 */
async function scanByKeyset(
  label: string,
  page: (after: string | null) => PromiseLike<{ data: unknown; error: PgError | null }>,
  visit: (row: Record<string, unknown>) => void,
): Promise<string | null> {
  let after: string | null = null;
  for (let n = 0; n < SCAN_MAX_PAGES; n += 1) {
    const { data, error } = await page(after);
    if (error) return errorText(`${label} read`, error);
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return null;
    for (const raw of rows) {
      const row = asObject(raw);
      if (row) visit(row);
    }
    const last = asText(asObject(rows[rows.length - 1])?.id);
    if (!last) return `${label}: row without id`;
    after = last;
  }
  return `${label}: more than ${SCAN_PAGE * SCAN_MAX_PAGES} rows`;
}

/**
 * Стоит ли какой-то из адресов в пресете клиента или в живом запуске
 * RU-кабинета (см. HeSendingPoolMailboxUse). Адреса сравниваются обрезанными
 * и в нижнем регистре: пул хранит нижний регистр, а экран администратора
 * пишет в пресет адрес так, как его отдаёт рассыльщик. Поэтому фильтр по
 * массиву в запросе не годится (он точный) — читаются все пресеты и все живые
 * запуски с выбранными ящиками, сравнение — здесь.
 * `exceptPresetOfClient` — не считать пресет этого клиента (ENG-клиент, чей
 * пресет пишет engSendingPreset из ящиков пула). Его запуски в журнале RU
 * считаются: ENG-кабинет журнал не пишет.
 * Не бросает; ошибка чтения — kind 'error' (вызывающий отказывает).
 */
export async function findHeSendingPoolMailboxUses(
  instantlyDb: SupabaseClient,
  emails: string[],
  opts: { exceptPresetOfClient?: string | null } = {},
): Promise<HeSendingPoolMailboxUses> {
  const wanted = new Set(emails.map(normalizeMailboxAddress).filter(Boolean));
  if (wanted.size === 0) return { kind: 'free' };
  const uses: HeSendingPoolMailboxUse[] = [];
  const hits = (list: unknown): string[] =>
    Array.isArray(list) ? [...new Set(list.map(normalizeMailboxAddress).filter((e) => wanted.has(e)))] : [];
  try {
    const presetsFailed = await scanByKeyset(
      'client_campaign_presets',
      (after) => {
        let q = instantlyDb.from('client_campaign_presets').select('id, client_user_id, email_account_ids');
        if (after) q = q.gt('id', after);
        return q.order('id', { ascending: true }).limit(SCAN_PAGE);
      },
      (row) => {
        const clientUserId = String(row.client_user_id ?? '');
        if (opts.exceptPresetOfClient && clientUserId === opts.exceptPresetOfClient) return;
        for (const email of hits(row.email_account_ids)) {
          if (uses.length < USES_MAX) uses.push({ source: 'preset', email, clientUserId });
        }
      },
    );
    if (presetsFailed) return { kind: 'error', message: presetsFailed };

    const launchesFailed = await scanByKeyset(
      'client_campaign_launches',
      (after) => {
        let q = instantlyDb
          .from('client_campaign_launches')
          .select('id, client_user_id, instantly_campaign_id, email_account_ids, status')
          .in('status', LIVE_LAUNCH_STATUSES)
          .not('email_account_ids', 'is', null);
        if (after) q = q.gt('id', after);
        return q.order('id', { ascending: true }).limit(SCAN_PAGE);
      },
      (row) => {
        for (const email of hits(row.email_account_ids)) {
          if (uses.length >= USES_MAX) break;
          uses.push({
            source: 'launch',
            email,
            clientUserId: String(row.client_user_id ?? ''),
            campaignId: asText(row.instantly_campaign_id),
            status: String(row.status ?? ''),
          });
        }
      },
    );
    if (launchesFailed) return { kind: 'error', message: launchesFailed };
  } catch (e) {
    return { kind: 'error', message: `mailbox uses read threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
  return uses.length > 0 ? { kind: 'in_use', uses } : { kind: 'free' };
}

/** Находки findHeSendingPoolMailboxUses одной строкой для сотрудника (по-русски). */
export function describeHeSendingPoolMailboxUses(uses: HeSendingPoolMailboxUse[]): string {
  return uses
    .map((u) =>
      u.source === 'preset'
        ? `${u.email} — в пресете клиента ${u.clientUserId}`
        : `${u.email} — в запуске RU-кабинета клиента ${u.clientUserId} ` +
          `(кампания ${u.campaignId ?? 'ещё не создана'}, статус ${u.status})`,
    )
    .join('; ');
}

/* ─────────────── Сотрудник: возврат и статус ─────────────── */

export type HeSendingPoolReleaseResult =
  | { kind: 'released'; mailboxes: Array<HeSendingPoolMailbox & { instantlyAccountId: string }> }
  | { kind: 'nothing_assigned' }
  /** У проекта есть запуск — ничего не возвращено (шапка миграции, пункт 4). */
  | { kind: 'launched' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export async function releaseHeSendingPool(db: SupabaseClient, projectId: string): Promise<HeSendingPoolReleaseResult> {
  const call = await callPoolRpc(db, RELEASE_RPC, { p_project_id: projectId });
  if (call.kind !== 'answer') return call;
  switch (call.answer.outcome) {
    case 'released': {
      const raw = Array.isArray(call.answer.mailboxes) ? call.answer.mailboxes : null;
      const mailboxes: Array<HeSendingPoolMailbox & { instantlyAccountId: string }> = [];
      for (const item of raw ?? []) {
        const row = asObject(item);
        const id = asText(row?.id);
        const email = asText(row?.email);
        const instantlyAccountId = asText(row?.instantly_account_id);
        if (!id || !email || !instantlyAccountId) return { kind: 'error', message: `${RELEASE_RPC}: malformed answer` };
        mailboxes.push({ id, email, instantlyAccountId });
      }
      if (!raw) return { kind: 'error', message: `${RELEASE_RPC}: malformed answer` };
      return { kind: 'released', mailboxes };
    }
    case 'nothing_assigned':
      return { kind: 'nothing_assigned' };
    case 'launched':
      return { kind: 'launched' };
    default:
      return { kind: 'error', message: `${RELEASE_RPC}: unexpected outcome ${String(call.answer.outcome).slice(0, 40)}` };
  }
}

export type HeSendingPoolSetStatusResult =
  | { kind: 'updated'; status: 'available' | 'disabled' }
  | { kind: 'unchanged' }
  /** Ящик отдан проекту — статус не меняется (шапка миграции, пункт 5). */
  | { kind: 'assigned' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export async function setHeSendingPoolMailboxStatus(
  db: SupabaseClient,
  id: string,
  status: 'available' | 'disabled',
): Promise<HeSendingPoolSetStatusResult> {
  const call = await callPoolRpc(db, SET_STATUS_RPC, { p_id: id, p_status: status });
  if (call.kind !== 'answer') return call;
  switch (call.answer.outcome) {
    case 'updated':
      return { kind: 'updated', status };
    case 'unchanged':
      return { kind: 'unchanged' };
    case 'assigned':
      return { kind: 'assigned' };
    case 'not_found':
      return { kind: 'not_found' };
    default:
      return { kind: 'error', message: `${SET_STATUS_RPC}: unexpected outcome ${String(call.answer.outcome).slice(0, 40)}` };
  }
}

/* ─────────────── Сотрудник: проверка ящика у рассыльщика ─────────────── */

export type HeSendingPoolProviderCheck =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Перед добавлением в пул: ящик есть в ЭТОМ воркспейсе рассыльщика (GET
 * /accounts/{email} ключом воркспейса), он активен (статус 1), настройка
 * закончена и прогрев не в отрицательном статусе (бан / спам / блокировка).
 * Один GET через общий ограничитель транспорта, без повторов на 429 и со
 * сроком 10 с — staff-роут живёт 30 с. LIST /emails не трогается.
 * Не бросает. Тексты — сотруднику, по-русски.
 */
export async function checkHeSendingPoolMailboxAtProvider(
  email: string,
  instantlyAccountId: string,
): Promise<HeSendingPoolProviderCheck> {
  try {
    const account = await getAccount(email, {
      accountId: instantlyAccountId,
      consumer: 'he_sending_pool',
      retryRateLimits: false,
      timeoutMs: 10_000,
    });
    if (!account || typeof account !== 'object') {
      return { ok: false, status: 502, message: 'Рассыльщик вернул пустой ответ по ящику — попробуйте ещё раз' };
    }
    if (account.setup_pending === true) {
      return { ok: false, status: 422, message: 'Настройка ящика у рассыльщика не закончена (setup pending)' };
    }
    if (account.status !== AccountStatus.Active) {
      const label = AccountStatusLabels[Number(account.status)] ?? `статус ${String(account.status)}`;
      return { ok: false, status: 422, message: `Ящик у рассыльщика не активен: ${label}` };
    }
    const warmup = Number(account.warmup_status);
    if (Number.isFinite(warmup) && warmup < 0) {
      const label = WarmupStatusLabels[warmup] ?? `статус ${warmup}`;
      return { ok: false, status: 422, message: `Прогрев ящика в плохом статусе: ${label}` };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof InstantlyApiError && e.status === 404) {
      return { ok: false, status: 422, message: 'Такого ящика нет в выбранном воркспейсе рассыльщика' };
    }
    if (e instanceof InstantlyApiError && e.status === 503) {
      return { ok: false, status: 503, message: 'Воркспейс рассыльщика не настроен в окружении (нет ключа)' };
    }
    const status = e instanceof InstantlyApiError ? e.status : null;
    return {
      ok: false,
      status: 502,
      message: `Не удалось проверить ящик у рассыльщика${status ? ` (HTTP ${status})` : ''} — попробуйте ещё раз`,
    };
  }
}

/* ─────────────── Алерт команде ─────────────── */

/**
 * Что сообщить команде в health-бот (тот же транспорт, что у opsAlert):
 *  - 'shortage' — запуск клиента отказан: свободных ящиков в одном годном
 *    воркспейсе меньше нужного (ничего не отдано);
 *  - 'low' — выдача прошла, но свободных в воркспейсе осталось меньше, чем
 *    нужно следующему новому проекту: следующий новый клиент получит отказ;
 *  - 'conflict' — запуск отказан конфликтом воркспейса или ящиком пула в
 *    чужом пресете / живом запуске RU-кабинета (разбирает сотрудник, см.
 *    engSendingPreset.ts);
 *  - 'unavailable' — отказан любой запуск ENG-клиента: пул недоступен
 *    (cause 'pool_missing' — миграция 20261011_0001 не применена) или
 *    воркспейсы рассыльщика не читаются из окружения (cause 'workspaces').
 * Клиентские фразы на этот алерт НЕ опираются (они про «напишите в Support»,
 * а не про «команда уже знает»), поэтому без кредов Telegram кабинет не врёт.
 */
export type HeSendingPoolAlert =
  | {
      kind: 'shortage';
      projectId: string;
      need: number;
      bestFree: number;
      pinnedWorkspace: string | null;
      byWorkspace: Record<string, number>;
    }
  | { kind: 'low'; projectId: string; instantlyAccountId: string; freeLeft: number; perProject: number }
  | { kind: 'conflict'; projectId: string; reason: string; detail?: string | null }
  | { kind: 'unavailable'; projectId: string; cause: 'pool_missing' | 'workspaces'; reason: string };

const ALERT_WORKER_ID = 'hypothesis-engine · ENG';

/**
 * ДЕДУПЛИКАЦИЯ — в памяти процесса, окно HE_OPS_TEAM_FIX_REPEAT_MS (1 ч) по
 * ключу:
 *  - shortage / low — по виду и воркспейсу (закреплённому или «любой»): пул
 *    пополняет сотрудник, это одна новость, сколько бы клиентов в неё ни
 *    упёрлось за час;
 *  - conflict — по проекту и причине (разбирается у каждого проекта своё);
 *  - unavailable — по причине (cause).
 * Окно держится, только если сообщение принял хоть один чат; иначе снимается
 * по настоящему исходу отправки, и следующий такой же случай пишет снова.
 * После рестарта процесса та же новость может прийти ещё раз.
 */
const silentUntil = new Map<string, { until: number }>();

function alertKey(alert: HeSendingPoolAlert): string {
  switch (alert.kind) {
    case 'shortage':
      return `shortage|${alert.pinnedWorkspace ?? '*'}`;
    case 'low':
      return `low|${alert.instantlyAccountId}`;
    case 'conflict':
      return `conflict|${alert.projectId}|${alert.reason}`;
    case 'unavailable':
      return `unavailable|${alert.cause}`;
  }
}

function alertBody(alert: HeSendingPoolAlert): { subject: string; error: string; context: Record<string, string | number | null> } {
  switch (alert.kind) {
    case 'shortage': {
      const free = Object.entries(alert.byWorkspace).map(([ws, n]) => `${ws}: ${n}`).join(', ') || 'нет ни одного';
      return {
        subject: 'пул ящиков ENG: не хватило ящиков — запуск клиента отказан',
        error: `нужно ${alert.need} в одном воркспейсе, есть ${alert.bestFree}` +
          (alert.pinnedWorkspace ? ` (проект закреплён за воркспейсом ${alert.pinnedWorkspace}: у клиента есть запуск)` : ''),
        context: {
          'проект': alert.projectId,
          'свободно по воркспейсам': free,
          'клиент видит': 'нет свободных ящиков отправки — напишите в Support',
          'сделать':
            'добавить прогретые ящики в пул: Движок вертикалей v1 → «Пул ящиков ENG»' +
            (alert.pinnedWorkspace ? ` (в воркспейс ${alert.pinnedWorkspace})` : '') +
            '; клиент повторяет запуск сам',
        },
      };
    }
    case 'low':
      return {
        subject: 'пул ящиков ENG почти пуст — следующий новый клиент получит отказ',
        error: `в воркспейсе ${alert.instantlyAccountId} свободно ${alert.freeLeft}, новому проекту нужно ${alert.perProject}`,
        context: {
          'проект, получивший ящики': alert.projectId,
          'сделать': 'добавить прогретые ящики в пул: Движок вертикалей v1 → «Пул ящиков ENG»',
        },
      };
    case 'conflict':
      return {
        subject: 'пул ящиков ENG: запуск клиента отказан — конфликт настройки отправки',
        error: heOpsReasonText(`${alert.reason}${alert.detail ? `: ${alert.detail}` : ''}`),
        context: {
          'проект': alert.projectId,
          'клиент видит': 'проблема на нашей стороне — напишите в Support',
          'сделать':
            'сверить ящики проекта в «Пул ящиков ENG» с пресетом клиента (/admin/clients/<клиент>/preset): ' +
            'воркспейс пресета и ящики пула должны совпадать; ящик пула не должен стоять ни в чужом пресете ' +
            '(снять его там на /admin/clients/<чужой клиент>/preset), ни в живом запуске RU-кабинета ' +
            '(его кампания уже шлёт из ящика — решить с владельцем, кто остаётся с ящиком)',
        },
      };
    case 'unavailable':
      return {
        subject:
          alert.cause === 'workspaces'
            ? 'ENG: воркспейсы рассыльщика не настроены — отказан любой запуск ENG-клиента'
            : 'пул ящиков ENG недоступен — отказан любой запуск ENG-клиента',
        error: heOpsReasonText(alert.reason),
        context: {
          'проект': alert.projectId,
          'клиент видит': 'проблема на нашей стороне — напишите в Support',
          'сделать':
            alert.cause === 'workspaces'
              ? 'проверить INSTANTLY_API_KEY и INSTANTLY_ACCOUNTS_JSON в контейнере portal'
              : 'применить миграцию 20261011_0001_he_sending_pool.sql',
        },
      };
  }
}

/**
 * Сообщить команде (см. HeSendingPoolAlert). Решение «слать / молчать» —
 * синхронно, до первого await. НЕ БРОСАЕТ и не держит вызывающего дольше
 * HE_OPS_SEND_TIMEOUT_MS; вызывающий в веб-процессе может не ждать (`void`).
 */
export function notifyHeSendingPool(alert: HeSendingPoolAlert, opts: { now?: number } = {}): Promise<void> {
  try {
    const now = opts.now ?? Date.now();
    for (const [key, hold] of silentUntil) {
      if (now >= hold.until) silentUntil.delete(key);
    }
    const key = alertKey(alert);
    const current = silentUntil.get(key);
    if (current && now < current.until) return Promise.resolve();
    const hold = { until: now + HE_OPS_TEAM_FIX_REPEAT_MS };
    silentUntil.set(key, hold);

    const body = alertBody(alert);
    const delivered = sendWorkerAlert({ workerId: ALERT_WORKER_ID, ...body }).catch(() => false);
    void delivered
      .then((accepted) => {
        if (!accepted && silentUntil.get(key) === hold) silentUntil.delete(key);
      })
      .catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HE_OPS_SEND_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([delivered.then(() => undefined), deadline]).then(
      () => {
        if (timer) clearTimeout(timer);
      },
      () => {
        if (timer) clearTimeout(timer);
      },
    );
  } catch (e) {
    console.warn('[he-sending-pool] алерт не собран:', e);
    return Promise.resolve();
  }
}
