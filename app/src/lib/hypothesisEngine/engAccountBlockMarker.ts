/**
 * ENG: отметка блокировки аккаунта (таблица he_eng_account_blocks, миграция
 * 20261013_0001 — её шапка: колонки и как они пишутся).
 *
 * Решение владельца 12.10.2026: «если бан, то всё нужно останавливать и
 * блокировать». Бан входа без этой отметки держит только НОВОЕ (вход, новые
 * платные шаги, ночной добор, автозапуск и письма клиенту читают и бан), а
 * уже идущее не останавливает: кампании отправляют, джобы из очереди воркера
 * дорабатывают, выключатель отправки и «Daily top-up» не меняются (шапка
 * миграции, «ЗАЧЕМ»). Поэтому блокировка ENG-клиента ПЕРВЫМ шагом пишет эту
 * отметку, и каждый фоновый путь, который тратит деньги, начинает отправку
 * или пишет клиенту, читает её здесь — одним читателем на всех.
 *
 * ВЕРДИКТ ЧТЕНИЯ (readHeEngAccountBlock / readHeEngAccountBlocks):
 *  - 'blocked' — строка с active = true;
 *  - 'clear'   — строки нет или active = false;
 *  - 'missing' — таблицы нет (42P01 / PGRST205: миграция не применена). Путь
 *                работает как до блокировки; одно предупреждение в лог на
 *                процесс (здесь, вызывающему писать его не нужно);
 *  - 'error'   — любой другой сбой (и брошенное чтение). Вызывающий считает
 *                его «не сейчас / отказ»: работа и отправка не продолжаются.
 *                `code` — код Postgres/PostgREST (null — брошено или без
 *                кода): по нему вызывающий отличает разовый сбой от
 *                постоянного (например 42501 — нет прав).
 *
 * НИЧЕГО ЗДЕСЬ НЕ БРОСАЕТ. Модуль лёгкий намеренно (только тип клиента БД и
 * журнал): его импортируют гейт платных шагов, письма клиенту, автозапуск,
 * ночной добор и воркер — ни Instantly, ни отправки он за собой не тянет.
 * Здесь же — правило «остановка блокировки не подтверждена»
 * (heEngLastStopDoubt): по нему карточка ЗАБЛОКИРОВАННОГО клиента называет в
 * вопросе перед «Разблокировать», что блокировка не подтвердила (разблокировка
 * сама повторяет всю остановку до снятия бана — engAccountBlock).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logWarn } from '@/lib/loggerServer';
import type { HeEngSendingAccess } from './engSendingAccess';

export const HE_ENG_ACCOUNT_BLOCKS_TABLE = 'he_eng_account_blocks';

/** Миграция таблицы — для строки отчёта «примените миграцию …». */
export const HE_ENG_ACCOUNT_BLOCKS_MIGRATION = '20261013_0001';

/** Сколько id в одном `.in()` пакетного чтения. */
export const HE_ENG_ACCOUNT_BLOCKS_CHUNK = 200;

/* ─────────────── Типы строки ─────────────── */

/** Выключатель отправки при первом нажатии эпизода (CHECK миграции — тот же список). */
export const HE_ENG_SENDING_BEFORE_VALUES = [
  'enabled',
  'not_enabled',
  'waiting',
  'revoked',
  'not_required',
  'unknown',
] as const;
export type HeEngSendingBefore = (typeof HE_ENG_SENDING_BEFORE_VALUES)[number];

/** «Daily top-up» проекта при первом нажатии эпизода. */
export const HE_ENG_REFILL_BEFORE_VALUES = ['on', 'off', 'no_config', 'unknown'] as const;
export type HeEngRefillBefore = (typeof HE_ENG_REFILL_BEFORE_VALUES)[number];

/** project_id → состояние «Daily top-up» до блокировки. */
export type HeEngRefillBeforeMap = Record<string, HeEngRefillBefore>;

/** Строка отметки (колонки snake_case → поля camelCase). */
export interface HeEngAccountBlockRow {
  userId: string;
  active: boolean;
  blockedAt: string;
  lastBlockAt: string;
  blockedBy: string | null;
  unblockedAt: string | null;
  unblockedBy: string | null;
  sendingBefore: HeEngSendingBefore;
  /** null — до блокировки не прочитано. */
  refillEnabledBefore: HeEngRefillBeforeMap | null;
  /**
   * Отчёт последней блокировки. Поля нет — его не читали (`withReport` не
   * задан); null — отчёта нет или он не разбирается.
   */
  lastStop?: HeEngBlockReport | null;
  /**
   * Кто открыл эпизод (last_stop.opened_by): 'unblock' — «Разблокировать» у
   * бана без отметки (она пишет отметку перед своей остановкой), иначе
   * 'block'. Поля нет — last_stop не читали.
   */
  openedBy?: 'block' | 'unblock';
  updatedAt: string;
}

/* ─────────────── Отчёт блокировки (last_stop и ответ роута) ─────────────── */

/** Строка отчёта для сотрудника: зелёная, красная или пояснение. */
export interface HeEngBlockLine {
  tone: 'ok' | 'red' | 'note';
  text: string;
}

/** Что сделала остановка одного us-проекта аккаунта (engProjectStop, режим 'staff_block'). */
export interface HeEngBlockProjectReport {
  project_id: string;
  /** Сайт проекта — для строки отчёта; null — не прочитан. */
  website: string | null;
  /** he_projects.autopilot = false (+ cancelled_at). */
  autopilot: 'off' | 'failed';
  /** Автозапуск проекта: 'none' — его не было (или нет таблицы 20261012_0001). */
  intent: 'cancelled' | 'none' | 'failed';
  /** «Daily top-up» (выключается всегда): 'unsupported' — нет таблицы конфигов добора. */
  top_up: 'turned_off' | 'already_off' | 'unsupported' | 'failed';
  /** Сколько he_jobs pending/running стало 'cancelled'. */
  jobs: number | 'failed';
  /** Сколько баз 'collecting'/'analyzing' стало 'failed'. */
  bases: number | 'failed';
  /** Сколько джоб конструктора и Google Maps остановлено. */
  children: number | 'failed';
  /**
   * Исследование: 'stopped' — шло и остановлено (проект → 'draft'). Кто
   * запустит его снова — вердикт шага 1 (readHeEngAccountResearch,
   * engResearchRetryVerdict): клиент кнопкой «Try again» или только команда.
   */
  research: 'stopped' | 'not_running' | 'failed';
  /** Все записи проекта легли. */
  ok: boolean;
}

/**
 * Кампания, которую кабинет не может поставить на паузу (пауза 'staff_block',
 * engCampaignSending): воркспейс, где она читалась удачно, не настроен или его
 * нет, а запасного (пресет клиента, ящики пула проекта) тоже нет — или в
 * запасном её нет («404»). Так бывает у кампаний, запущенных не из кабинета
 * (инструментом сотрудника чужим пресетом). Ставит её на паузу только человек
 * в Instantly.
 */
export interface HeEngUnreachableCampaign {
  campaign_id: string;
  /** Имя из записи о запуске; null — нет. */
  name: string | null;
  /** Воркспейс удачного чтения (строка статуса), даже если он не настроен; null — не читалась. */
  workspace: string | null;
  /** Запасной воркспейс, ответивший «404»; null — запасного не было. */
  not_found_in: string | null;
}

/** Пауза кампаний аккаунта — те же поля, что у pauseHeEngAccountSending ('staff_block'). */
export interface HeEngBlockCampaignsReport {
  launches: number;
  paused: number;
  failed: number;
  notAttempted: number;
  unreadLaunches: number;
  readFailed: boolean;
  /**
   * Из `paused`: засчитаны без нового вызова — не отправляющий статус прочитан
   * у рассыльщика после начала блокировки (только разблокировка).
   */
  confirmedEarlier: number;
  /** Не на паузе и кабинету недоступны — каждую ставит на паузу человек. */
  unreachable: HeEngUnreachableCampaign[];
}

export interface HeEngBlockReport {
  /** Всё остановлено (правило — у вызывающего, engAccountBlock). */
  complete: boolean;
  /**
   * Эпизод отметки открыла «Разблокировать» (бан стоял без отметки), а это —
   * отчёт «Заблокировать», нажатого позже в том же эпизоде: признак переносится
   * сюда, чтобы карточка не выдала время того «Разблокировать» за блокировку.
   */
  opened_by?: 'unblock';
  marker: 'ok' | 'missing' | 'failed';
  sending_switch: 'revoked' | 'already' | 'failed';
  ban: 'ok' | 'failed';
  sessions: 'ok' | 'failed';
  /**
   * Список us-проектов аккаунта прочитан. 'failed' — `projects` пуст не
   * потому, что проектов нет.
   */
  projects_read: 'ok' | 'failed';
  projects: HeEngBlockProjectReport[];
  /** Сколько неотправленных писем клиенту снято из очереди. */
  client_emails: number | 'failed';
  campaigns: HeEngBlockCampaignsReport;
}

/**
 * Остановка аккаунта без отметки, бана и сессий — общая часть блокировки и
 * разблокировки (engAccountBlock): выключатель отправки, работа проектов,
 * очередь писем клиенту, пауза кампаний.
 */
export type HeEngAccountStopReport = Pick<
  HeEngBlockReport,
  'sending_switch' | 'projects_read' | 'projects' | 'client_emails' | 'campaigns'
>;

/* ─────────────── «Остановка блокировки не подтверждена» ─────────────── */

/**
 * Часть остановки проекта, без которой разблокированный клиент мог бы снова
 * отправлять или платить сам: ночной добор («Daily top-up» — ночью покупает
 * сборку и снова стартует завершённую кампанию), автопилот (ставит следующие
 * платные шаги) и автозапуск «Launch» (запускает и стартует рынки).
 */
export type HeEngStopDoubtPart = 'top_up' | 'autopilot' | 'intent';

const HE_ENG_STOP_DOUBT_PARTS: readonly HeEngStopDoubtPart[] = ['top_up', 'autopilot', 'intent'];

export interface HeEngStopDoubtProject {
  project_id: string;
  website: string | null;
  parts: HeEngStopDoubtPart[];
}

/**
 * Что из остановки последней блокировки не подтверждено:
 *  - 'all' — неизвестно ни про один проект: отчёта нет или он не читается
 *    ('no_report'), или список проектов при блокировке не прочитался
 *    ('projects_unread'); сомнение — во всех трёх частях каждого проекта;
 *  - 'projects' — проекты отчёта, у которых часть не подтверждена.
 */
export type HeEngStopDoubt =
  | { scope: 'all'; why: 'no_report' | 'projects_unread' }
  | { scope: 'projects'; projects: HeEngStopDoubtProject[] };

const TOP_UP_CONFIRMED: ReadonlyArray<unknown> = ['turned_off', 'already_off', 'unsupported'];
const INTENT_CONFIRMED: ReadonlyArray<unknown> = ['cancelled', 'none'];

/**
 * Правило «остановка блокировки не подтверждена» — для вопроса карточки
 * заблокированного клиента перед «Разблокировать» (engAdminView,
 * card.block.stop_doubt). Подтверждено — только когда отчёт есть, список
 * проектов в нём прочитан, и у каждого проекта: «Daily top-up» выключен (или
 * уже был, или таблицы добора нет), автопилот выключен, автозапуск отменён
 * (или его не было). Любое другое значение поля — в том числе форма, которую
 * писал не этот код, — «не подтверждено». null — подтверждено.
 */
export function heEngLastStopDoubt(lastStop: HeEngBlockReport | null | undefined): HeEngStopDoubt | null {
  if (!lastStop) return { scope: 'all', why: 'no_report' };
  if (lastStop.projects_read !== 'ok') return { scope: 'all', why: 'projects_unread' };
  const projects: HeEngStopDoubtProject[] = [];
  for (const raw of lastStop.projects as unknown[]) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<HeEngBlockProjectReport>;
    const parts: HeEngStopDoubtPart[] = [];
    if (!TOP_UP_CONFIRMED.includes(p.top_up)) parts.push('top_up');
    if (p.autopilot !== 'off') parts.push('autopilot');
    if (!INTENT_CONFIRMED.includes(p.intent)) parts.push('intent');
    if (parts.length === 0) continue;
    projects.push({
      project_id: typeof p.project_id === 'string' ? p.project_id : '',
      website: typeof p.website === 'string' ? p.website : null,
      parts,
    });
  }
  return projects.length > 0 ? { scope: 'projects', projects } : null;
}

/** Часть остановки — для строк сотрудника. */
const HE_ENG_STOP_DOUBT_PART_TEXT: Record<HeEngStopDoubtPart, string> = {
  top_up: 'ночной добор («Daily top-up»)',
  autopilot: 'автопилот',
  intent: 'автозапуск «Launch»',
};

/** Что не подтверждено — одна фраза для сотрудника (без точки в конце). */
export function heEngStopDoubtText(d: HeEngStopDoubt): string {
  if (d.scope === 'all') {
    return d.why === 'no_report'
      ? 'отчёта последней блокировки нет или он не читается — неизвестно, выключила ли она ночной добор ' +
          '(«Daily top-up»), автопилот и автозапуск «Launch»'
      : 'при последней блокировке проекты клиента не прочитались — ночной добор («Daily top-up»), автопилот ' +
          'и автозапуск «Launch» она не выключала';
  }
  const groups = HE_ENG_STOP_DOUBT_PARTS.flatMap((part) => {
    const sites = d.projects.filter((p) => p.parts.includes(part)).map((p) => p.website ?? (p.project_id || 'проект'));
    return sites.length > 0 ? [`${HE_ENG_STOP_DOUBT_PART_TEXT[part]} — ${sites.join(', ')}`] : [];
  });
  return `блокировка не подтвердила, что выключила: ${groups.join('; ')}`;
}

/**
 * Может ли клиент сам снова запустить исследование не исследованного проекта —
 * вердиктом шага 1 (researchJob.engResearchRetryVerdict, то же чтение, что у
 * деталки проекта): 'try_again' — «Try again» на шаге 1 есть; 'team_fix' —
 * есть, но сначала команда чинит отказ провайдера (деньги или настройка, коды
 * 'billing' / 'configuration'); 'team' — из кабинета не запустить, только
 * команда (остановлено не техническим сбоем); 'running' — идёт.
 */
export type HeEngResearchRestart = 'try_again' | 'team_fix' | 'team' | 'running';

/** Отчёт разблокировки (только в ответе роута и аудите; в таблицу не пишется). */
export interface HeEngUnblockReport {
  complete: boolean;
  /**
   * Отметка до разблокировки: 'active' — была; 'none' — не было (бан мимо
   * раздела или отметка блокировки не записалась) — перед остановкой её
   * пишут, как «Заблокировать»; 'missing' — таблицы нет; 'unread' — строка не
   * прочиталась (остановка идёт без записи отметки).
   */
  marker_before: 'active' | 'none' | 'missing' | 'unread';
  /**
   * Кто открыл эпизод, который снимает это нажатие (при marker_before
   * 'active' и при marker_written 'taken'): 'unblock' — «Разблокировать» у
   * бана без отметки (прошлое или параллельное), тогда состояния «до» прочитаны
   * перед его остановкой; null — эпизод открыло само это нажатие или его нет.
   */
  opened_by: 'block' | 'unblock' | null;
  /**
   * Бан входа перед разблокировкой (шаг 0): true — стоял; false — не стоял
   * (держала одна отметка: бан при «Заблокировать» не поставился, или прошлое
   * «Разблокировать» сняло бан, а отметку — нет); null — не прочитался.
   */
  ban_before: boolean | null;
  /**
   * Запись отметки перед остановкой (только при 'none'); 'taken' — отметку по
   * ходу уже завело другое нажатие (`opened_by` — какое); null — не писали.
   */
  marker_written: 'ok' | 'taken' | 'missing' | 'failed' | null;
  /** Остановка перед снятием бана; `confirmed` — всё подтверждено (иначе бан не снимали). */
  stop: HeEngAccountStopReport & { confirmed: boolean };
  /** 'kept' — бан не снимали (почему — `kept_by`). */
  ban: 'lifted' | 'failed' | 'kept';
  /**
   * Почему бан не снимали: 'stop' — остановка не подтверждена; 'reblocked' —
   * пока шла разблокировка, нажали «Заблокировать» (last_block_at отметки уже
   * не тот, что у эпизода этого нажатия); 'unverified' — перед снятием это не удалось
   * проверить (отметка не перечиталась или появилась, а своей у нажатия нет).
   * null — бан снимали.
   */
  kept_by: 'stop' | 'reblocked' | 'unverified' | null;
  /**
   * 'not_blocked' — активной отметки не было; 'skipped' — бан не снят, и
   * отметку не трогали: вход закрыт, фоновые пути должны и дальше видеть блок;
   * 'superseded' — бан снят, но отметку уже сдвинуло «Заблокировать», нажатое
   * по ходу: она не снята, а бан ставится снова (`reban`).
   */
  marker: 'cleared' | 'not_blocked' | 'missing' | 'failed' | 'skipped' | 'superseded';
  /** Бан, поставленный снова после 'superseded'; null — не ставили. */
  reban: 'ok' | 'failed' | null;
  /**
   * Выключатель отправки «до» из отметки: при 'active' — до блокировки, при
   * 'none' — прочитанный перед этой остановкой; null — не прочитан.
   */
  sending_before: HeEngSendingBefore | null;
  refill_enabled_before: HeEngRefillBeforeMap | null;
  /**
   * Не исследованные проекты после снятия бана и кто снова запустит их
   * исследование; null — не читали (бан не снят) или не прочиталось.
   */
  research: Array<{ project_id: string; website: string | null; restart: HeEngResearchRestart }> | null;
}

/* ─────────────── Вердикт чтения ─────────────── */

export interface HeEngAccountBlockedInfo {
  blockedAt: string;
  lastBlockAt: string;
}

export type HeEngAccountBlockState =
  | ({ state: 'blocked' } & HeEngAccountBlockedInfo)
  | { state: 'clear' }
  | { state: 'missing'; detail: string }
  | { state: 'error'; detail: string; code: string | null };

export type HeEngAccountBlocksRead =
  /** Каждый запрошенный id, которого нет в `blocked`, — 'clear'. */
  | { state: 'ok'; blocked: ReadonlyMap<string, HeEngAccountBlockedInfo> }
  | { state: 'missing'; detail: string }
  | { state: 'error'; detail: string; code: string | null };

export type HeEngAccountBlockRowsRead =
  /** Строки, которые есть (активные и снятые); id без строки в карте нет. */
  | { state: 'ok'; rows: ReadonlyMap<string, HeEngAccountBlockRow> }
  | { state: 'missing'; detail: string }
  | { state: 'error'; detail: string; code: string | null };

/* ─────────────── Служебное ─────────────── */

interface PgError {
  code?: string | null;
  message?: string | null;
}

function isTableMissing(error: PgError | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42P01' || code === 'PGRST205';
}

function errText(prefix: string, error: PgError | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

function threwText(prefix: string, e: unknown): string {
  return `${prefix} threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

let missingWarned = false;

/** Таблицы нет — одно предупреждение на процесс, дальше молча. */
function noteMissing(detail: string): void {
  if (missingWarned) return;
  missingWarned = true;
  void logWarn(
    'he.eng_account_block.table_missing',
    `${HE_ENG_ACCOUNT_BLOCKS_TABLE} missing (migration ${HE_ENG_ACCOUNT_BLOCKS_MIGRATION} not applied) — background paths do not see ENG blocks`,
    { detail },
  );
}

/** Сбой запроса → 'missing' (с предупреждением) или 'error'. */
function failure(prefix: string, error: PgError): { state: 'missing'; detail: string } | { state: 'error'; detail: string; code: string | null } {
  const detail = errText(prefix, error);
  if (isTableMissing(error)) {
    noteMissing(detail);
    return { state: 'missing', detail };
  }
  return { state: 'error', detail, code: error.code ?? null };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** blocked_at / last_block_at строки (обе NOT NULL; одна подменяет другую на всякий случай). */
function blockedInfo(raw: Record<string, unknown>): HeEngAccountBlockedInfo {
  const blockedAt = str(raw.blocked_at) ?? str(raw.last_block_at) ?? '';
  return { blockedAt, lastBlockAt: str(raw.last_block_at) ?? blockedAt };
}

function sendingBeforeOf(v: unknown): HeEngSendingBefore {
  return (HE_ENG_SENDING_BEFORE_VALUES as readonly string[]).includes(v as string) ? (v as HeEngSendingBefore) : 'unknown';
}

function refillBeforeOf(v: unknown): HeEngRefillBeforeMap | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: HeEngRefillBeforeMap = {};
  for (const [projectId, state] of Object.entries(v as Record<string, unknown>)) {
    out[projectId] = (HE_ENG_REFILL_BEFORE_VALUES as readonly string[]).includes(state as string)
      ? (state as HeEngRefillBefore)
      : 'unknown';
  }
  return out;
}

/**
 * Отчёт из jsonb. Пишет его только наш код, но строку читает экран
 * сотрудника: не та форма — null («отчёт не читается»), а не падение.
 */
export function parseHeEngBlockReport(raw: unknown): HeEngBlockReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const campaigns = r.campaigns;
  if (
    typeof r.complete !== 'boolean'
    || !Array.isArray(r.projects)
    || !campaigns
    || typeof campaigns !== 'object'
    || Array.isArray(campaigns)
    || !Array.isArray((campaigns as Record<string, unknown>).unreachable)
  ) {
    return null;
  }
  return raw as HeEngBlockReport;
}

const ROW_COLUMNS =
  'user_id, active, blocked_at, last_block_at, blocked_by, unblocked_at, unblocked_by, sending_before, refill_enabled_before, updated_at';

function rowColumns(withReport: boolean): string {
  return withReport ? `${ROW_COLUMNS}, last_stop` : ROW_COLUMNS;
}

/** Кто открыл эпизод — по last_stop (его первая запись — markHeEngAccountBlocked). */
function openedByOf(lastStop: unknown): 'block' | 'unblock' {
  return lastStop && typeof lastStop === 'object' && (lastStop as { opened_by?: unknown }).opened_by === 'unblock'
    ? 'unblock'
    : 'block';
}

function parseRow(raw: unknown, withReport: boolean): HeEngAccountBlockRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.user_id);
  if (!userId) return null;
  const info = blockedInfo(r);
  return {
    userId,
    active: r.active === true,
    blockedAt: info.blockedAt,
    lastBlockAt: info.lastBlockAt,
    blockedBy: str(r.blocked_by),
    unblockedAt: str(r.unblocked_at),
    unblockedBy: str(r.unblocked_by),
    sendingBefore: sendingBeforeOf(r.sending_before),
    refillEnabledBefore: refillBeforeOf(r.refill_enabled_before),
    ...(withReport ? { lastStop: parseHeEngBlockReport(r.last_stop), openedBy: openedByOf(r.last_stop) } : {}),
    updatedAt: str(r.updated_at) ?? info.lastBlockAt,
  };
}

/* ─────────────── Чтение ─────────────── */

/**
 * Вердикт одного аккаунта — для стража перед работой. Пустой id — 'clear'
 * без запроса (у строки без владельца отметки быть не может).
 */
export async function readHeEngAccountBlock(db: SupabaseClient, userId: string): Promise<HeEngAccountBlockState> {
  if (typeof userId !== 'string' || userId.length === 0) return { state: 'clear' };
  try {
    const { data, error } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .select('active, blocked_at, last_block_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return failure('he_eng_account_blocks read', error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row || row.active !== true) return { state: 'clear' };
    return { state: 'blocked', ...blockedInfo(row) };
  } catch (e) {
    return { state: 'error', detail: threwText('he_eng_account_blocks read', e), code: null };
  }
}

/**
 * Вердикт пачки аккаунтов: по `.in()` не больше HE_ENG_ACCOUNT_BLOCKS_CHUNK id,
 * пакеты по очереди. Сбой ЛЮБОГО пакета — весь ответ 'error' (половины ответа
 * не бывает: непрочитанный аккаунт нельзя счесть 'clear'). Пустой список —
 * 'ok' без запроса.
 */
export async function readHeEngAccountBlocks(
  db: SupabaseClient,
  userIds: readonly string[],
): Promise<HeEngAccountBlocksRead> {
  const blocked = new Map<string, HeEngAccountBlockedInfo>();
  const ids = uniqueIds(userIds);
  try {
    for (const chunk of chunks(ids, HE_ENG_ACCOUNT_BLOCKS_CHUNK)) {
      const { data, error } = await db
        .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
        .select('user_id, blocked_at, last_block_at')
        .in('user_id', chunk)
        .eq('active', true);
      if (error) return failure('he_eng_account_blocks batch read', error);
      for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
        const userId = str(raw.user_id);
        if (userId) blocked.set(userId, blockedInfo(raw));
      }
    }
  } catch (e) {
    return { state: 'error', detail: threwText('he_eng_account_blocks batch read', e), code: null };
  }
  return { state: 'ok', blocked };
}

/** Вердикт одного аккаунта из пакетного чтения — та же форма, что у readHeEngAccountBlock. */
export function heEngAccountBlockOf(read: HeEngAccountBlocksRead, userId: string): HeEngAccountBlockState {
  if (read.state !== 'ok') return read;
  const info = read.blocked.get(userId);
  return info ? { state: 'blocked', ...info } : { state: 'clear' };
}

/**
 * Полные строки (экран сотрудника, отчёт разблокировки): активные и снятые.
 * `withReport` — читать и `last_stop`. Пакеты и правило сбоя — как у
 * readHeEngAccountBlocks.
 */
export async function readHeEngAccountBlockRows(
  db: SupabaseClient,
  userIds: readonly string[],
  opts: { withReport?: boolean } = {},
): Promise<HeEngAccountBlockRowsRead> {
  const withReport = opts.withReport === true;
  const rows = new Map<string, HeEngAccountBlockRow>();
  const ids = uniqueIds(userIds);
  try {
    for (const chunk of chunks(ids, HE_ENG_ACCOUNT_BLOCKS_CHUNK)) {
      const { data, error } = await db
        .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
        .select(rowColumns(withReport))
        .in('user_id', chunk);
      if (error) return failure('he_eng_account_blocks rows read', error);
      for (const raw of (data ?? []) as unknown[]) {
        const row = parseRow(raw, withReport);
        if (row) rows.set(row.userId, row);
      }
    }
  } catch (e) {
    return { state: 'error', detail: threwText('he_eng_account_blocks rows read', e), code: null };
  }
  return { state: 'ok', rows };
}

/**
 * `sending_before` из чтения выключателя (readHeEngSendingAccess): 'waiting' —
 * не включали, а клиент уже упёрся в выключатель (requested_at); не клиент ENG,
 * нет таблицы и сбой — 'unknown'.
 */
export function heEngSendingBeforeOf(access: Pick<HeEngSendingAccess, 'state' | 'requestedAt'>): HeEngSendingBefore {
  switch (access.state) {
    case 'enabled':
      return 'enabled';
    case 'revoked':
      return 'revoked';
    case 'not_required':
      return 'not_required';
    case 'not_enabled':
      return access.requestedAt ? 'waiting' : 'not_enabled';
    case 'not_client':
    case 'unavailable':
    case 'error':
      return 'unknown';
  }
}

/* ─────────────── Запись ─────────────── */

export type HeEngAccountBlockMark =
  /** Первое нажатие эпизода: строка заведена или снятая отметка включена заново. */
  | { state: 'new'; row: HeEngAccountBlockRow }
  /**
   * Повтор: блокировка уже действовала — сдвинуты только last_block_at и
   * blocked_by; blocked_at, sending_before и refill_enabled_before — от
   * первого нажатия (в `row`; там же `openedBy` эпизода).
   */
  | { state: 'repeat'; row: HeEngAccountBlockRow }
  /**
   * Только `openedBy: 'unblock'`: активная отметка уже есть — её завела
   * «Заблокировать» или параллельное «Разблокировать», нажатые по ходу
   * (`row.openedBy` говорит, кто); эта запись её не трогает.
   */
  | { state: 'taken'; row: HeEngAccountBlockRow }
  | { state: 'missing'; detail: string }
  | { state: 'error'; detail: string; code: string | null };

/**
 * Включить отметку. Три условные записи, каждая атомарна:
 *  1. повтор — UPDATE по active = true (last_block_at, blocked_by);
 *  2. новый эпизод снятой отметки — UPDATE по active = false: blocked_at,
 *     sending_before, refill_enabled_before заново, снятие и отчёт прошлого
 *     эпизода стёрты;
 *  3. первой строки нет — INSERT. Два первых нажатия разом: второй INSERT
 *     получает 23505 и повторяет шаг 1 (его нажатие — повтор, состояния «до»
 *     остаются от первого).
 * `sendingBefore` / `refillEnabledBefore` вызывающий читает ДО остановки —
 * в повторе они не используются. `openedBy: 'unblock'` — эпизод открывает
 * «Разблокировать» у бана без отметки: только новый эпизод (шаги 2–3, last_stop
 * — { opened_by: 'unblock' }); активную отметку оно не повторяет — её завело
 * нажатие, сделанное по ходу (`taken`, строка — какая есть), и сдвигать её
 * last_block_at назад, к началу разблокировки, нельзя. НЕ БРОСАЕТ.
 */
export async function markHeEngAccountBlocked(
  db: SupabaseClient,
  input: {
    userId: string;
    staffUserId: string | null;
    now: Date;
    sendingBefore: HeEngSendingBefore;
    refillEnabledBefore: HeEngRefillBeforeMap | null;
    openedBy?: 'unblock';
  },
): Promise<HeEngAccountBlockMark> {
  const nowIso = input.now.toISOString();
  const repeat = async (): Promise<HeEngAccountBlockMark | null> => {
    const { data, error } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .update({ last_block_at: nowIso, blocked_by: input.staffUserId, updated_at: nowIso })
      .eq('user_id', input.userId)
      .eq('active', true)
      .select(rowColumns(true));
    if (error) return failure('he_eng_account_blocks repeat', error);
    const row = parseRow((data ?? [])[0], true);
    return row ? { state: 'repeat', row } : null;
  };
  const byUnblock = input.openedBy === 'unblock';
  try {
    if (!byUnblock) {
      const repeated = await repeat();
      if (repeated) return repeated;
    }

    const episode = {
      active: true,
      blocked_at: nowIso,
      last_block_at: nowIso,
      blocked_by: input.staffUserId,
      unblocked_at: null,
      unblocked_by: null,
      sending_before: input.sendingBefore,
      refill_enabled_before: input.refillEnabledBefore,
      last_stop: input.openedBy === 'unblock' ? { opened_by: 'unblock' } : null,
      updated_at: nowIso,
    };
    const { data: revived, error: reviveErr } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .update(episode)
      .eq('user_id', input.userId)
      .eq('active', false)
      .select(ROW_COLUMNS);
    if (reviveErr) return failure('he_eng_account_blocks new episode', reviveErr);
    const revivedRow = parseRow((revived ?? [])[0], false);
    if (revivedRow) return { state: 'new', row: revivedRow };

    const { data: inserted, error: insertErr } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .insert({ user_id: input.userId, ...episode })
      .select(ROW_COLUMNS);
    if (insertErr) {
      if (insertErr.code === '23505') {
        // Строка уже есть: у разблокировки — активная отметка «Заблокировать»
        // (снятую оживил бы шаг 2) или такая же гонка; у блокировки — её
        // завела параллельная блокировка, и это нажатие — повтор.
        if (byUnblock) {
          const { data: current, error: readErr } = await db
            .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
            .select(rowColumns(true))
            .eq('user_id', input.userId)
            .eq('active', true)
            .maybeSingle();
          if (readErr) return failure('he_eng_account_blocks taken read', readErr);
          const row = parseRow(current, true);
          return row
            ? { state: 'taken', row }
            : { state: 'error', detail: 'he_eng_account_blocks insert raced and no active row was found', code: null };
        }
        const raced = await repeat();
        if (raced) return raced;
        return { state: 'error', detail: 'he_eng_account_blocks insert raced and the repeat found no active row', code: null };
      }
      return failure('he_eng_account_blocks insert', insertErr);
    }
    const insertedRow = parseRow((inserted ?? [])[0], false);
    return insertedRow
      ? { state: 'new', row: insertedRow }
      : { state: 'error', detail: 'he_eng_account_blocks insert returned no row', code: null };
  } catch (e) {
    return { state: 'error', detail: threwText('he_eng_account_blocks mark', e), code: null };
  }
}

export type HeEngAccountBlockReportWrite =
  | 'ok'
  /** Активная строка есть, но её last_block_at новее этого нажатия — отчёт более позднего нажатия не затирается. */
  | 'superseded'
  /**
   * Активной строки нет: отметка не записалась, или эпизод уже снят
   * разблокировкой — отчёт остаётся только в ответе и аудите.
   */
  | 'no_row'
  | 'missing'
  | 'error';

/**
 * Записать отчёт нажатия в last_stop АКТИВНОЙ отметки. Только пока
 * last_block_at не новее `blockAt` (момента ЭТОГО нажатия): медленное старое
 * нажатие не затирает отчёт более позднего, а в снятую строку прошлого эпизода
 * отчёт не пишется. Строку не создаёт. НЕ БРОСАЕТ.
 */
export async function writeHeEngAccountBlockReport(
  db: SupabaseClient,
  input: { userId: string; blockAt: Date; report: HeEngBlockReport; now?: Date },
): Promise<HeEngAccountBlockReportWrite> {
  const blockAtIso = input.blockAt.toISOString();
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const { data, error } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .update({ last_stop: input.report, updated_at: nowIso })
      .eq('user_id', input.userId)
      .eq('active', true)
      .lte('last_block_at', blockAtIso)
      .select('user_id');
    if (error) return failure('he_eng_account_blocks report', error).state;
    if ((data ?? []).length > 0) return 'ok';
    const { data: existing, error: readErr } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .select('active')
      .eq('user_id', input.userId)
      .maybeSingle();
    if (readErr) return failure('he_eng_account_blocks report check', readErr).state;
    return (existing as { active?: unknown } | null)?.active === true ? 'superseded' : 'no_row';
  } catch {
    return 'error';
  }
}

export type HeEngAccountUnblockMark =
  /** Отметка снята; `row` — уже снятая строка (sending_before и др. для отчёта). */
  | { state: 'unblocked'; row: HeEngAccountBlockRow }
  /** Активной отметки нет (не блокировали через карточку или уже сняли). */
  | { state: 'not_blocked' }
  /**
   * Активная отметка есть, но не та, что снимает нажатие: её last_block_at
   * сдвинуло «Заблокировать», нажатое по ходу разблокировки, или у нажатия
   * своей отметки не было. Не снята.
   */
  | { state: 'superseded' }
  | { state: 'missing'; detail: string }
  | { state: 'error'; detail: string; code: string | null };

/**
 * Снять отметку эпизода, который снимает разблокировка: условный UPDATE по
 * active = true и last_block_at, равному `episodeAt` (тому, что это нажатие
 * прочитало или само записало). «Заблокировать», нажатое по ходу
 * разблокировки, сдвигает last_block_at — такую отметку UPDATE не задевает
 * ('superseded'). `episodeAt` null — у нажатия отметки не было: ничего не
 * снимается, только читается, активна ли отметка сейчас. Зовётся
 * только после удачного снятия бана (пока вход закрыт, фоновые пути должны
 * видеть блок). Ни выключатель отправки, ни автозапуск, ни кампании не
 * трогает. НЕ БРОСАЕТ.
 */
export async function markHeEngAccountUnblocked(
  db: SupabaseClient,
  input: { userId: string; staffUserId: string | null; now: Date; episodeAt: string | null },
): Promise<HeEngAccountUnblockMark> {
  const nowIso = input.now.toISOString();
  try {
    if (input.episodeAt !== null) {
      const { data, error } = await db
        .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
        .update({ active: false, unblocked_at: nowIso, unblocked_by: input.staffUserId, updated_at: nowIso })
        .eq('user_id', input.userId)
        .eq('active', true)
        .eq('last_block_at', input.episodeAt)
        .select(ROW_COLUMNS);
      if (error) return failure('he_eng_account_blocks unblock', error);
      const row = parseRow((data ?? [])[0], false);
      if (row) return { state: 'unblocked', row };
    }
    const { data: current, error: readErr } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .select('active')
      .eq('user_id', input.userId)
      .maybeSingle();
    if (readErr) return failure('he_eng_account_blocks unblock check', readErr);
    return (current as { active?: unknown } | null)?.active === true ? { state: 'superseded' } : { state: 'not_blocked' };
  } catch (e) {
    return { state: 'error', detail: threwText('he_eng_account_blocks unblock', e), code: null };
  }
}
