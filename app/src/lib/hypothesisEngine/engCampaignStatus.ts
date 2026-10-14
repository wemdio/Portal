/**
 * ENG: настоящий статус кампаний запуска и их счётчики (отправлено / ответы)
 * для кабинета — дашборда (Command Center) и шага 5 «Review & Launch».
 *
 * ОТКУДА. Кэш he_eng_campaign_status (миграция 20261011_0002) — общий для всех
 * процессов portal. Живое чтение — только API кампаний рассыльщика, НИКОГДА не
 * LIST /emails: GET /campaigns/{id} (статус) и GET /campaigns/analytics?id=
 * (emails_sent_count, reply_count_unique). Оба идут через общий транспорт
 * lib/instantly (тот же ограничитель воркспейса, что у всех вызовов кроме
 * /emails), без повторов на 429 и со сроком READ_TIMEOUT_MS.
 *
 * КАК ЧАСТО. Кампания перечитывается не чаще раза в HE_ENG_STATUS_FRESH_MS
 * (5 мин) на ВСЕ процессы: живое чтение берёт аренду строки функцией
 * he_eng_campaign_status_claim (одна заявка на кампанию за раз), неудача
 * откладывает следующую попытку на FAILURE_BACKOFF_MS. Счётчики — реже
 * статуса и не чаще раза в HE_ENG_COUNTS_FRESH_MS (20 мин) с последней
 * ПОПЫТКИ (counts_tried_at пишется и при неудаче): когда их ещё нет, прошлая
 * попытка не удалась, статус не тот, при котором они прочитаны (counts_status
 * — кто бы его ни записал), или они старше 20 мин у отправляющей кампании и
 * старше HE_ENG_COUNTS_IDLE_MS (6 ч) у стоящей и завершённой: писем те не
 * шлют, но ответы на отправленные приходят и после паузы и завершения. Чтение
 * идёт фоном (дашборд не ждёт рассыльщика): свежие числа видны на следующем
 * опросе. Кроме того, старт и пауза (engCampaignSending.ts) пишут статус,
 * прочитанный у рассыльщика в момент действия.
 *
 * ЧЕГО НЕ ВЫДУМЫВАЕМ. Нет строки или статус не читался — 'unknown' («status
 * not read yet»); чтение не удалось — показываем последнее прочитанное с его
 * временем (`status_as_of`, `status_stale`); счётчиков нет у какой-либо
 * кампании — сумма не печатается (null), а не печатается частичная.
 *
 * ПАУЗА КЛИЕНТА ДЕРЖИТСЯ И ЗДЕСЬ. Живое чтение, которое видит отправляющую
 * кампанию запуска, поставленного клиентом на паузу (he_eng_launch_sending =
 * 'paused', перечитано прямо перед действием), ставит её на паузу: так
 * доводятся пауза, которую рассыльщик не принял с первого раза, старт,
 * доехавший до рассыльщика после ответа «не удалось», и старт мимо кабинета.
 * Так же — отправляющую кампанию аккаунта, отправку которого выключил
 * сотрудник ('revoked', engSendingAccess), или заблокированного аккаунта
 * (активная отметка he_eng_account_blocks, engAccountBlockMarker); оба
 * перечитаны на это чтение.
 *
 * ВОРКСПЕЙС КАМПАНИИ. Удачное живое чтение (здесь, при старте и паузе)
 * записывает в строку воркспейс, в котором кампания нашлась
 * (instantly_account_id): пауза идёт туда, и только там «404» значит
 * «кампании нет» (engCampaignSending.pauseHeEngLaunchSending).
 *
 * Модуль НЕ БРОСАЕТ наружу: каждая функция отвечает значением.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaign, getCampaignAnalytics, pauseCampaign } from '@/lib/instantly/client';
import { InstantlyApiError } from '@/lib/instantly/errors';
import { listInstantlyAccounts, resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { CampaignStatus } from '@/lib/instantly/types';
import { logAudit, logWarn } from '@/lib/loggerServer';
import type { HeTemplateLaunchInfo } from './launchHandoff';
import { readHeEngSendingAccess, type HeEngSendingAccessState } from './engSendingAccess';
import { readHeEngAccountBlock } from './engAccountBlockMarker';
import { notifyHeEngSending } from './engSendingAlert';
import { checkHeCampaignAgainstAssignment, HE_SENDING_POOL_TABLE, readHeSendingPoolAssignment } from './sendingPool';

export const HE_ENG_CAMPAIGN_STATUS_TABLE = 'he_eng_campaign_status';
export const HE_ENG_LAUNCH_SENDING_TABLE = 'he_eng_launch_sending';
const CLAIM_RPC = 'he_eng_campaign_status_claim';

/** Сколько живёт прочитанный статус до следующего живого чтения. */
export const HE_ENG_STATUS_FRESH_MS = 5 * 60_000;
/**
 * Счётчики (отправлено / ответы) отправляющей кампании перечитываются не чаще
 * — реже статуса: GET /campaigns/analytics тратит тот же бюджет воркспейса.
 */
const HE_ENG_COUNTS_FRESH_MS = 20 * 60_000;
/**
 * Счётчики НЕ отправляющей кампании (стоит, завершена) — не реже раза в столько:
 * писем она не шлёт, но ответы на отправленные приходят и после паузы и
 * завершения.
 */
const HE_ENG_COUNTS_IDLE_MS = 6 * 60 * 60_000;
/** После неудачного чтения следующая попытка — не раньше. */
const FAILURE_BACKOFF_MS = 5 * 60_000;
/** Статус старше этого — «as of …» (чтения не удаются). */
const STALE_AFTER_MS = 3 * HE_ENG_STATUS_FRESH_MS;
const READ_TIMEOUT_MS = 8_000;
/**
 * Вызовов рассыльщика на одну кампанию в худшем случае: статус, пауза
 * (доводка), проверочное чтение после неясной паузы, счётчики.
 */
const CALLS_PER_CAMPAIGN = 4;
/**
 * Сколько общий ограничитель воркспейса может держать один вызов перед
 * отправкой (lib/instantly/rateLimiter.ts: INSTANTLY_RATE_LIMITER_MAX_WAIT_MS,
 * по умолчанию 15 с; та же формула чтения env).
 */
function limiterMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INSTANTLY_RATE_LIMITER_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}
/**
 * Аренда живого чтения ОДНОЙ кампании (берётся прямо перед её чтением): худший
 * случай всех её вызовов — ожидание ограничителя плюс срок каждого — и запас
 * на запись в БД. Так вторая заявка не начинает читать ту же кампанию, пока
 * первая ещё читает.
 */
function leaseSeconds(): number {
  return Math.ceil((CALLS_PER_CAMPAIGN * (READ_TIMEOUT_MS + limiterMaxWaitMs())) / 1000) + 30;
}
/** Сколько кампаний одно фоновое обновление читает за раз. */
const REFRESH_MAX_CAMPAIGNS = 10;
/** Метка счётчика использования рассыльщика (instantly_api_usage_hourly). */
export const HE_ENG_STATUS_CONSUMER = 'he_eng_campaign_status';

/**
 * Воркспейс рассыльщика настроен в окружении portal (INSTANTLY_API_KEY для
 * 'main', INSTANTLY_ACCOUNTS_JSON для остальных). resolveInstantlyAccountId
 * только нормализует id и не бросает — ненастроенный воркспейс всплыл бы
 * лишь отказом первого вызова. Битый INSTANTLY_ACCOUNTS_JSON — «не настроен».
 */
export function heEngWorkspaceConfigured(accountId: string): boolean {
  try {
    const id = resolveInstantlyAccountId(accountId);
    return listInstantlyAccounts().some((a) => a.id === id);
  } catch {
    return false;
  }
}

/* ─────────────── Статусы рассыльщика ─────────────── */

export function heEngStatusIsSending(status: number | null | undefined): boolean {
  return status === CampaignStatus.Active || status === CampaignStatus.RunningSubsequences;
}

/** Не отправляет, и стартовать можно: черновик (0) или пауза (2). */
export function heEngStatusIsStartable(status: number | null | undefined): boolean {
  return status === CampaignStatus.Draft || status === CampaignStatus.Paused;
}

/** Остановлена у рассыльщика: аккаунт заблокирован, ящики нездоровы, защита от bounce. */
export function heEngStatusIsStopped(status: number | null | undefined): boolean {
  return (
    status === CampaignStatus.AccountSuspended ||
    status === CampaignStatus.AccountsUnhealthy ||
    status === CampaignStatus.BounceProtect
  );
}

/* ─────────────── Кампании запуска ─────────────── */

export interface HeEngLaunchCampaign {
  campaignId: string;
  /** Адресов в кампании по записи: принятых + найденных уже лежащими. */
  leads: number;
}

/**
 * Кампании записи о запуске: список `campaigns`, а у записи до сплита —
 * скалярная основная. Дубли id сворачиваются.
 */
export function heEngLaunchCampaigns(launch: HeTemplateLaunchInfo): HeEngLaunchCampaign[] {
  const list = launch.campaigns?.length
    ? launch.campaigns.map((c) => ({ id: c.campaign_id, leads: c.leads_count + (c.leads_already_present ?? 0) }))
    : [{ id: launch.campaign_id, leads: launch.leads_count + (launch.leads_already_present ?? 0) }];
  const out = new Map<string, HeEngLaunchCampaign>();
  for (const c of list) {
    if (!c.id) continue;
    const prev = out.get(c.id);
    out.set(c.id, { campaignId: c.id, leads: (prev?.leads ?? 0) + Math.max(0, c.leads) });
  }
  return [...out.values()];
}

/* ─────────────── Строка кэша ─────────────── */

/** Почему последний старт кампании не удался (кабинет: engText.engSendingProblemText). */
export type HeEngStartErrorCode =
  /** Адреса кампании не из ящиков пула проекта или кампания в другом воркспейсе. */
  | 'mailboxes_changed'
  /** Рассыльщик остановил кампанию (отрицательный статус). */
  | 'needs_attention'
  /** Кампании у рассыльщика нет. */
  | 'not_found'
  /** Перед стартом кампанию не прочитали. */
  | 'read_failed'
  /** Старт не подтвердился: ответ ясный (отказ, статус не «отправляет») или проверочное чтение показало стоящую. */
  | 'start_failed'
  /**
   * Старт НЕЯСЕН: ответ POST /activate не пришёл (срок, обрыв) и проверочное
   * чтение не удалось — кампания МОГЛА начать отправку. Это не «не стартована»:
   * статус — «не знаем» (status null), Pause есть, а живое чтение заменит код
   * на 'start_failed', если кампания прочитается стоящей, или снимет его.
   */
  | 'start_unconfirmed';

const START_ERROR_CODES: ReadonlySet<string> = new Set([
  'mailboxes_changed',
  'needs_attention',
  'not_found',
  'read_failed',
  'start_failed',
  'start_unconfirmed',
]);

export interface HeEngCampaignStatusRow {
  campaign_id: string;
  status: number | null;
  status_read_at: string | null;
  sent: number | null;
  replies: number | null;
  counts_read_at: string | null;
  /**
   * Когда счётчики последний раз ПРОБОВАЛИ прочитать (удачно или нет); нет
   * ключа / null — не пробовали (строки, собранные в памяти, его не несут).
   */
  counts_tried_at?: string | null;
  /**
   * Статус кампании при последнем УДАЧНОМ чтении счётчиков. Отличается от
   * нынешнего статуса — счётчики пора перечитать, кто бы статус ни записал
   * (живое чтение, пауза, старт, гейт ночи). undefined — колонки нет
   * (миграция старой редакции, деградация) или строка собрана в памяти.
   */
  counts_status?: number | null;
  read_error: 'not_found' | 'failed' | null;
  refresh_until: string | null;
  start_error: HeEngStartErrorCode | null;
  /**
   * Воркспейс, в котором кампания нашлась при удачном живом чтении; null / нет
   * ключа — не читалась удачно (ключ необязателен: строки, собранные в памяти
   * без чтения кэша, его не несут).
   */
  instantly_account_id?: string | null;
}

// Одной строкой-литералом: из склейки клиент Supabase не выводит тип строк.
const ROW_COLUMNS =
  'campaign_id, status, status_read_at, sent, replies, counts_read_at, counts_tried_at, counts_status, read_error, refresh_until, start_error, instantly_account_id';
/**
 * Колонки первой редакции миграции 20261011_0002 — на случай, если в БД она, а
 * не нынешняя (42703 на ROW_COLUMNS): кэш читается без поздних колонок, пишется
 * без них (withoutLateColumns), а миграцию надо перекатить (она идемпотентна).
 */
const LEGACY_ROW_COLUMNS =
  'campaign_id, status, status_read_at, sent, replies, counts_read_at, read_error, refresh_until, start_error';
const LATE_COLUMNS = ['counts_tried_at', 'counts_status', 'instantly_account_id'] as const;

function isColumnMissing(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === '42703';
}

/** Запись без поздних колонок кэша — деградация при 42703 (см. LEGACY_ROW_COLUMNS). */
function withoutLateColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const c of LATE_COLUMNS) delete out[c];
  return out;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function toRow(raw: Record<string, unknown>): HeEngCampaignStatusRow {
  const readError = raw.read_error === 'not_found' || raw.read_error === 'failed' ? raw.read_error : null;
  const startError = typeof raw.start_error === 'string' && START_ERROR_CODES.has(raw.start_error)
    ? (raw.start_error as HeEngStartErrorCode)
    : null;
  return {
    campaign_id: String(raw.campaign_id ?? ''),
    status: num(raw.status),
    status_read_at: text(raw.status_read_at),
    sent: num(raw.sent),
    replies: num(raw.replies),
    counts_read_at: text(raw.counts_read_at),
    counts_tried_at: text(raw.counts_tried_at),
    ...('counts_status' in raw ? { counts_status: num(raw.counts_status) } : {}),
    read_error: readError,
    refresh_until: text(raw.refresh_until),
    start_error: startError,
    instantly_account_id: text(raw.instantly_account_id),
  };
}

interface PgError {
  code?: string | null;
  message?: string | null;
}

function isMissing(error: PgError | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202';
}

function pgText(prefix: string, error: PgError | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

/** Одна строка warn на причину в окно — чтение идёт на каждом опросе. */
const DEGRADED_LOG_WINDOW_MS = 10 * 60 * 1000;
const degradedLoggedAt = new Map<string, number>();

export function warnHeEngSendingDegraded(key: string, message: string, context: Record<string, unknown>): void {
  const now = Date.now();
  if (now - (degradedLoggedAt.get(key) ?? 0) < DEGRADED_LOG_WINDOW_MS) return;
  if (degradedLoggedAt.size >= 100) degradedLoggedAt.clear();
  degradedLoggedAt.set(key, now);
  void logWarn('he.eng_sending.degraded', message, context);
}

/** Строки кэша по id кампаний. Нет таблицы / сбой — null (статус не прочитан). */
export async function readHeEngCampaignStatusRows(
  db: SupabaseClient,
  campaignIds: string[],
): Promise<Map<string, HeEngCampaignStatusRow> | null> {
  const ids = [...new Set(campaignIds.filter(Boolean))];
  const out = new Map<string, HeEngCampaignStatusRow>();
  if (ids.length === 0) return out;
  try {
    const full = await db.from(HE_ENG_CAMPAIGN_STATUS_TABLE).select(ROW_COLUMNS).in('campaign_id', ids);
    let data: unknown[] | null = full.data;
    let error: PgError | null = full.error;
    if (isColumnMissing(error)) {
      // Кэш первой редакции миграции — читаем без поздних колонок.
      warnHeEngSendingDegraded(
        'status_columns_missing',
        `${pgText('he_eng_campaign_status read', error)} — re-run migration 20261011_0002 (late columns missing)`,
        { campaigns: ids.length },
      );
      const legacy = await db.from(HE_ENG_CAMPAIGN_STATUS_TABLE).select(LEGACY_ROW_COLUMNS).in('campaign_id', ids);
      data = legacy.data;
      error = legacy.error;
    }
    if (error) {
      warnHeEngSendingDegraded(
        isMissing(error) ? 'status_missing' : 'status_read',
        pgText('he_eng_campaign_status read', error),
        { campaigns: ids.length },
      );
      return null;
    }
    for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
      const row = toRow(raw);
      if (row.campaign_id) out.set(row.campaign_id, row);
    }
    return out;
  } catch (e) {
    warnHeEngSendingDegraded('status_read', `he_eng_campaign_status read threw: ${String(e).slice(0, 200)}`, {});
    return null;
  }
}

/**
 * Записать то, что прочитано у рассыльщика при действии (старт, пауза). Строку
 * заводит, если её нет. Сбой — строка warn: действие у рассыльщика уже
 * сделано, а кэш дочитает фоновое обновление. `workspace` — только воркспейс,
 * в котором рассыльщик кампанию ВЕРНУЛ (удачное чтение, старт или пауза).
 * `status: null` — статус НЕ известен (не прочитан, неясный старт без
 * подтверждения): время чтения стирается, кабинет читает кампанию как
 * 'unknown', и строка сразу ждёт живого чтения (heEngCampaignsDueForRefresh).
 */
export async function writeHeEngCampaignStatus(
  db: SupabaseClient,
  projectId: string,
  campaignId: string,
  patch: {
    status?: number | null;
    readError?: 'not_found' | 'failed' | null;
    startError?: HeEngStartErrorCode | null;
    workspace?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { campaign_id: campaignId, project_id: projectId };
  if (patch.status !== undefined) {
    row.status = patch.status;
    row.status_read_at = patch.status === null ? null : now;
  }
  if (patch.readError !== undefined) row.read_error = patch.readError;
  if (patch.startError !== undefined) row.start_error = patch.startError;
  if (patch.workspace) row.instantly_account_id = patch.workspace;
  try {
    let { error } = await db.from(HE_ENG_CAMPAIGN_STATUS_TABLE).upsert(row, { onConflict: 'campaign_id' });
    if (isColumnMissing(error)) {
      ({ error } = await db.from(HE_ENG_CAMPAIGN_STATUS_TABLE).upsert(withoutLateColumns(row), { onConflict: 'campaign_id' }));
    }
    // Записан определённый статус, а причину вызывающий не задал — неясный
    // старт ('start_unconfirmed') больше не правда: статус известен.
    if (!error && typeof patch.status === 'number' && patch.startError === undefined) {
      const cleared = await db
        .from(HE_ENG_CAMPAIGN_STATUS_TABLE)
        .update({ start_error: null })
        .eq('campaign_id', campaignId)
        .eq('start_error', 'start_unconfirmed');
      if (cleared.error) {
        warnHeEngSendingDegraded('status_write', pgText('he_eng_campaign_status unconfirmed clear', cleared.error), {
          projectId,
          campaignId,
        });
      }
    }
    if (error) {
      warnHeEngSendingDegraded(
        isMissing(error) ? 'status_missing' : 'status_write',
        pgText('he_eng_campaign_status upsert', error),
        { projectId, campaignId },
      );
    }
  } catch (e) {
    warnHeEngSendingDegraded('status_write', `he_eng_campaign_status upsert threw: ${String(e).slice(0, 200)}`, {});
  }
}

/* ─────────────── Желание клиента ─────────────── */

export type HeEngClientState = 'sending' | 'paused';

export interface HeEngClientStateRow {
  state: HeEngClientState;
  changedAt: string | null;
}

/** Строки he_eng_launch_sending по шаблонам. Нет таблицы / сбой — null. */
export async function readHeEngClientStates(
  db: SupabaseClient,
  templateIds: string[],
): Promise<Map<string, HeEngClientStateRow> | null> {
  const ids = [...new Set(templateIds.filter(Boolean))];
  const out = new Map<string, HeEngClientStateRow>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await db
      .from(HE_ENG_LAUNCH_SENDING_TABLE)
      .select('template_id, client_state, changed_at')
      .in('template_id', ids);
    if (error) {
      warnHeEngSendingDegraded(
        isMissing(error) ? 'state_missing' : 'state_read',
        pgText('he_eng_launch_sending read', error),
        { templates: ids.length },
      );
      return null;
    }
    for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
      const id = text(raw.template_id);
      if (!id || (raw.client_state !== 'sending' && raw.client_state !== 'paused')) continue;
      out.set(id, { state: raw.client_state, changedAt: text(raw.changed_at) });
    }
    return out;
  } catch (e) {
    warnHeEngSendingDegraded('state_read', `he_eng_launch_sending read threw: ${String(e).slice(0, 200)}`, {});
    return null;
  }
}

/* ─────────────── Запуск до self-serve отправки ─────────────── */

/**
 * Запас на расхождение часов приложения (created_at записи о запуске) и БД
 * (assigned_at пула): запуск считается созданным ДО выдачи ящиков, только если
 * он раньше на столько. Ошибка в эту сторону безопасна — такой запуск
 * получает обычные кнопки, а старт его кампаний откажет проверка ящиков.
 */
const PRE_SELF_SERVE_MARGIN_MS = 60_000;

/**
 * Когда проекту впервые отданы ящики пула (самый ранний assigned_at строк
 * 'assigned'), по проектам. Нет ключа — проекту ящики не отданы. null —
 * таблица пула не читается (миграция 20261011_0001 / сбой): «до self-serve» не
 * решаем вовсе. НЕ БРОСАЕТ.
 */
export async function readHeEngPoolAssignedSince(
  db: SupabaseClient,
  projectIds: string[],
): Promise<Map<string, number> | null> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await db
      .from(HE_SENDING_POOL_TABLE)
      .select('project_id, assigned_at')
      .in('project_id', ids)
      .eq('status', 'assigned');
    if (error) {
      warnHeEngSendingDegraded('pool_since', pgText('he_sending_pool read', error), { projects: ids.length });
      return null;
    }
    for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
      const projectId = text(raw.project_id);
      const at = text(raw.assigned_at) ? Date.parse(String(raw.assigned_at)) : Number.NaN;
      if (!projectId || !Number.isFinite(at)) continue;
      const prev = out.get(projectId);
      if (prev === undefined || at < prev) out.set(projectId, at);
    }
    return out;
  } catch (e) {
    warnHeEngSendingDegraded('pool_since', `he_sending_pool read threw: ${String(e).slice(0, 200)}`, {});
    return null;
  }
}

/**
 * Запуск создан ДО self-serve отправки проекта: ядро записало его раньше, чем
 * проекту отданы ящики пула (или проекту их не отдавали вовсе — запуск до S2
 * или запуск сотрудника staff-инструментом без ящиков пула), — значит, его
 * кампании созданы ящиками другого пресета, и кабинет их не стартует (проверка
 * ящиков пула откажет). С S2 роут запуска отдаёт ящики ДО ядра, поэтому любой
 * запуск кабинета после S2 позже выдачи. Достройка старого запуска новым
 * нажатием пишет created_at своей попытки и считается запуском S2 (её новые
 * кампании — из ящиков пула; старые старт откажет поштучно). Запись без
 * created_at — формата до любого S2. `assignedSince` — ответ
 * readHeEngPoolAssignedSince; null (пул не читается) — false.
 */
export function heEngLaunchPredatesSelfServe(
  launch: Pick<HeTemplateLaunchInfo, 'created_at'>,
  projectId: string,
  assignedSince: ReadonlyMap<string, number> | null,
): boolean {
  if (assignedSince === null) return false;
  const since = assignedSince.get(projectId);
  if (since === undefined) return true;
  const createdAt = launch.created_at ? Date.parse(launch.created_at) : Number.NaN;
  if (!Number.isFinite(createdAt)) return true;
  return createdAt < since - PRE_SELF_SERVE_MARGIN_MS;
}

/* ─────────────── Сводка для кабинета ─────────────── */

/**
 * Состояние отправки запуска (вертикали) для кабинета — по кампаниям, у которых
 * есть адреса:
 *  - 'sending'     — хоть одна кампания отправляет (статус 1 или 4);
 *  - 'attention'   — ни одна не отправляет, а хоть одна остановлена
 *                    рассыльщиком (-99 / -1 / -2) или пропала у него;
 *  - 'completed'   — все прочитанные завершены (3): адреса кончились;
 *  - 'pre_self_serve' — стоят, и запуск создан до self-serve отправки проекта
 *                    (heEngLaunchPredatesSelfServe): кабинет его кампании не
 *                    стартует, кнопки старта нет — только Support;
 *  - 'paused'      — стоят (0 / 2), и клиент поставил паузу;
 *  - 'not_sending' — стоят, хотя клиент просил отправку (старт не удался или
 *                    кампанию остановили мимо кабинета);
 *  - 'not_started' — стоят, и отправку клиент не запрашивал (запуск, который
 *                    роут не стартовал: старый бандл, предупреждение запуска,
 *                    отказ старта);
 *  - 'unknown'     — статус ни одной кампании ещё не прочитан, или не прочитан
 *                    у части, а прочитанные не отправляют и не остановлены
 *                    (тогда ни «завершены», ни «не отправляют» не утверждаются:
 *                    непрочитанная может отправлять);
 *  - 'empty'       — ни в одной кампании нет адресов (отправлять некому).
 */
export type HeEngSendingState =
  | 'sending'
  | 'attention'
  | 'completed'
  | 'pre_self_serve'
  | 'paused'
  | 'not_sending'
  | 'not_started'
  | 'unknown'
  | 'empty';

export type HeEngSendingAction = 'pause' | 'start' | 'resume';

/**
 * Вторая кнопка карточки:
 *  - 'start_rest' — рядом с Pause: часть кампаний отправляет (или её статус не
 *    известен, а клиент просил отправку), часть стоит (старт не удался, не
 *    успел, остановлена мимо кабинета), клиент паузу не ставил и старт ему
 *    доступен. Нажатие — тот же POST .../sending { action: 'start' }:
 *    отправляющие кампании он не трогает;
 *  - 'pause' — рядом с «Start sending» в состоянии 'not_sending': клиент
 *    просил отправку, а всё стоит; Pause записывает, что отправка ему не нужна
 *    (и повторяет Pause, чьё желание не записалось).
 */
export type HeEngSendingSecondaryAction = 'start_rest' | 'pause';

/** Выключатель аккаунта — в той мере, в какой он меняет кнопки и фразы. */
export type HeEngSendingAccessView = 'ok' | 'not_enabled' | 'turned_off' | 'unavailable';

export function heEngSendingAccessView(state: HeEngSendingAccessState | null): HeEngSendingAccessView {
  switch (state) {
    case 'enabled':
    case 'not_required':
    case 'not_client':
      return 'ok';
    case 'not_enabled':
      return 'not_enabled';
    case 'revoked':
      return 'turned_off';
    default:
      return 'unavailable';
  }
}

export interface HeEngSendingSummary {
  state: HeEngSendingState;
  /** Кампаний запуска с адресами. */
  campaigns: number;
  /** Из них отправляют сейчас. */
  sending: number;
  /** Остановлены рассыльщиком или пропали у него. */
  attention: number;
  /** Стоят (0 / 2) — их можно стартовать (в любом состоянии сводки, и рядом с отправляющими). */
  startable: number;
  /** Статус не прочитан (нет строки, не читался, неясный старт) — может и отправлять. */
  unknown: number;
  /** Сумма отправленных писем; null — счётчики прочитаны не у всех кампаний. */
  sent: number | null;
  /** Сумма уникальных ответов (без автоответов); null — как у sent. */
  replies: number | null;
  /** Самое старое время счётчиков в сумме. */
  counts_as_of: string | null;
  /** Самое старое время прочитанного статуса. */
  status_as_of: string | null;
  /** Статус давно не обновлялся или последнее чтение не удалось — печатать «as of». */
  status_stale: boolean;
  /** Когда клиент поставил паузу (только у 'paused'). */
  paused_at: string | null;
  /** Кнопка карточки; null — кнопки нет. */
  action: HeEngSendingAction | null;
  /** Вторая кнопка ('start_rest' — рядом с Pause, 'pause' — рядом со «Start sending»); null — её нет. */
  secondary_action: HeEngSendingSecondaryAction | null;
  /**
   * Почему последний старт не удался — у СТОЯЩИХ кампаний (в любом состоянии
   * сводки, в том числе 'sending': часть отправляет, часть нет); у нескольких
   * причин — первая по порядку кампаний записи. null — ни у одной стоящей
   * кампании причины нет.
   */
  problem: HeEngStartErrorCode | null;
  /**
   * Сколько стоящих кампаний несут причину (любую); 0 — когда problem null.
   * Меньше `startable` — остальные стоящие причины не несут, и кнопка старта
   * (если есть) стартует их (engText: «press … to start the others»).
   */
  problem_campaigns: number;
  /**
   * Запуск создан до self-serve отправки проекта (heEngLaunchPredatesSelfServe)
   * — в ЛЮБОМ состоянии сводки (а не только в 'pre_self_serve'): у такого
   * запуска нет кнопки старта, «Pause» его останавливает, а стартует снова
   * только Support.
   */
  pre_self_serve: boolean;
  access: HeEngSendingAccessView;
  /**
   * false — статус этого запуска прочитать нечем: пресет записи о запуске не
   * пресет клиента (запуск сотрудника), его воркспейс не настроен или кэш
   * недоступен. Ставит читатель (readHeEngSendingSummaries); здесь — true.
   */
  readable: boolean;
}

/** Сводка запуска из кэша — чистая функция (её же печатают дашборд и шаг 5). */
export function summarizeHeEngSending(input: {
  campaigns: HeEngLaunchCampaign[];
  rows: ReadonlyMap<string, HeEngCampaignStatusRow> | null;
  clientState: HeEngClientStateRow | null;
  access: HeEngSendingAccessView;
  /** Запуск создан до self-serve отправки проекта (heEngLaunchPredatesSelfServe). */
  preSelfServe: boolean;
  now: number;
}): HeEngSendingSummary {
  const withLeads = input.campaigns.filter((c) => c.leads > 0);
  const clientState = input.clientState?.state ?? null;
  const base: HeEngSendingSummary = {
    state: 'unknown',
    campaigns: withLeads.length,
    sending: 0,
    attention: 0,
    startable: 0,
    unknown: 0,
    sent: null,
    replies: null,
    counts_as_of: null,
    status_as_of: null,
    status_stale: false,
    paused_at: null,
    action: null,
    secondary_action: null,
    problem: null,
    problem_campaigns: 0,
    pre_self_serve: input.preSelfServe,
    access: input.access,
    readable: true,
  };
  if (withLeads.length === 0) return { ...base, state: 'empty' };

  let sending = 0;
  let attention = 0;
  let completed = 0;
  let startable = 0;
  let unknown = 0;
  let sent = 0;
  let replies = 0;
  let countsKnown = true;
  let countsOldest: string | null = null;
  let statusOldest: string | null = null;
  let readFailed = false;
  let problem: HeEngStartErrorCode | null = null;
  let problemCampaigns = 0;
  for (const c of withLeads) {
    const row = input.rows?.get(c.campaignId) ?? null;
    if (row?.read_error === 'failed') readFailed = true;
    if (row?.status_read_at && (!statusOldest || row.status_read_at < statusOldest)) statusOldest = row.status_read_at;
    if (row && row.sent !== null && row.replies !== null && row.counts_read_at) {
      sent += row.sent;
      replies += row.replies;
      if (!countsOldest || row.counts_read_at < countsOldest) countsOldest = row.counts_read_at;
    } else {
      countsKnown = false;
    }
    const status = row?.status ?? null;
    if (row?.read_error === 'not_found' || heEngStatusIsStopped(status)) {
      attention += 1;
    } else if (heEngStatusIsSending(status)) {
      sending += 1;
    } else if (status === CampaignStatus.Completed) {
      completed += 1;
    } else if (heEngStatusIsStartable(status)) {
      startable += 1;
      if (row?.start_error) {
        problemCampaigns += 1;
        if (!problem) problem = row.start_error;
      }
    } else {
      unknown += 1;
    }
  }

  const statusTs = statusOldest ? Date.parse(statusOldest) : Number.NaN;
  const summary: HeEngSendingSummary = {
    ...base,
    sending,
    attention,
    startable,
    unknown,
    sent: countsKnown ? sent : null,
    replies: countsKnown ? replies : null,
    counts_as_of: countsKnown ? countsOldest : null,
    status_as_of: statusOldest,
    status_stale: readFailed || (Number.isFinite(statusTs) && input.now - statusTs > STALE_AFTER_MS),
    problem,
    problem_campaigns: problemCampaigns,
  };

  if (sending > 0) summary.state = 'sending';
  else if (attention > 0) summary.state = 'attention';
  else if (unknown === withLeads.length) summary.state = 'unknown';
  else if (startable === 0 && completed > 0) summary.state = 'completed';
  else if (input.preSelfServe) summary.state = 'pre_self_serve';
  else if (clientState === 'paused') summary.state = 'paused';
  else if (clientState === 'sending') summary.state = 'not_sending';
  else if (startable > 0) summary.state = 'not_started';
  else summary.state = 'unknown';
  // Статус части кампаний не прочитан, и ни одна не читается отправляющей —
  // «завершены» и «не отправляют» были бы утверждением и о непрочитанных
  // (они могут отправлять): состояние 'unknown' («N of M campaigns: status not
  // read yet»).
  if (unknown > 0 && (summary.state === 'completed' || summary.state === 'not_sending')) summary.state = 'unknown';

  if (summary.state === 'paused') summary.paused_at = input.clientState?.changedAt ?? null;

  // Кнопка. Пауза — всегда, когда что-то может отправлять (и когда статус не
  // прочитан, а клиент паузу не ставил: остановить можно всегда; у запуска до
  // self-serve — тоже: его кампании мог стартовать сотрудник). Старт — только
  // стоящим кампаниям, не выключенному аккаунту и не запуску до self-serve
  // (его старт откажет проверка ящиков пула); не включённый аккаунт кнопку
  // видит — отказ скажет, что отправку включает команда, и позовёт её.
  // Отправляет часть кампаний, а часть стоит — рядом с Pause вторая кнопка
  // 'start_rest' (если клиент паузу не ставил и старт ему доступен).
  const canStart = input.access !== 'turned_off' && !input.preSelfServe;
  if (sending > 0) {
    summary.action = 'pause';
    if (startable > 0 && clientState !== 'paused' && canStart) summary.secondary_action = 'start_rest';
  } else if (summary.state === 'unknown') {
    summary.action =
      clientState === 'paused'
        ? canStart
          ? 'resume'
          : null
        : clientState === 'sending' || input.preSelfServe
          ? 'pause'
          : canStart
            ? 'start'
            : null;
    // Часть стоит — «Start the rest» рядом с Pause.
    if (summary.action === 'pause' && startable > 0 && clientState === 'sending' && canStart) {
      summary.secondary_action = 'start_rest';
    }
  } else if (summary.state === 'not_sending') {
    // Клиент просил отправку, а все кампании стоят: старт — и рядом Pause, чтобы
    // записать, что отправка ему больше не нужна (в том числе повторить Pause,
    // чьё желание не записалось: тогда сводка видит прежнее 'sending').
    if (canStart) {
      summary.action = 'start';
      summary.secondary_action = 'pause';
    } else {
      summary.action = 'pause';
    }
  } else if (startable > 0 && canStart) summary.action = clientState === 'paused' ? 'resume' : 'start';

  // Статус части кампаний не известен (не читался, неясный старт без
  // подтверждения), а клиент просил отправку — какая-то из них МОЖЕТ
  // отправлять: Pause есть всегда. Кнопка старта, если она была, уходит
  // второй («Start the rest» стартует стоящие и не трогает отправляющие).
  if (unknown > 0 && clientState === 'sending' && summary.action !== 'pause') {
    if (summary.action === 'start' || summary.action === 'resume') summary.secondary_action = 'start_rest';
    summary.action = 'pause';
  }
  // Клиент поставил паузу, а статус части кампаний не известен (пауза не
  // подтвердилась) — какая-то может отправлять: Pause есть и здесь (второй
  // кнопкой рядом с «Resume» или единственной).
  if (unknown > 0 && clientState === 'paused' && summary.action !== 'pause' && summary.secondary_action !== 'pause') {
    if (summary.action) summary.secondary_action = 'pause';
    else summary.action = 'pause';
  }

  return summary;
}

/* ─────────────── Живое чтение (фоном) ─────────────── */

/** Кампании, которым пора живое чтение: статус старше свежести и аренды нет. */
export function heEngCampaignsDueForRefresh(
  campaignIds: string[],
  rows: ReadonlyMap<string, HeEngCampaignStatusRow> | null,
  now: number,
  freshMs: number = HE_ENG_STATUS_FRESH_MS,
): string[] {
  if (rows === null) return [];
  return campaignIds.filter((id) => {
    const row = rows.get(id);
    if (!row) return true;
    const lease = row.refresh_until ? Date.parse(row.refresh_until) : Number.NaN;
    if (Number.isFinite(lease) && lease > now) return false;
    const readAt = row.status_read_at ? Date.parse(row.status_read_at) : Number.NaN;
    return !Number.isFinite(readAt) || now - readAt >= freshMs;
  });
}

/** Клиентская пауза шаблона прямо сейчас (перед доводкой паузы). Не прочли — false. */
async function templateStillPaused(db: SupabaseClient, templateId: string): Promise<boolean> {
  const states = await readHeEngClientStates(db, [templateId]);
  return states?.get(templateId)?.state === 'paused';
}

/**
 * Отправку владельца проекта выключил сотрудник ('revoked', engSendingAccess)
 * или владелец заблокирован (активная отметка блокировки, engAccountBlockMarker)
 * — прямо сейчас. Оба читаются разом; хватает одного прочитанного «да». Не
 * прочли проект, выключатель или отметку — этот источник false: доводка паузы
 * идёт только по прочитанному выключению или блокировке (их же держат гейты
 * старта и долива), а следующее чтение статуса проверит снова.
 */
async function projectOwnerRevoked(db: SupabaseClient, projectId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from('he_projects').select('created_by').eq('id', projectId).maybeSingle();
    const owner = error ? null : text((data as { created_by?: unknown } | null)?.created_by);
    if (!owner) return false;
    const [access, block] = await Promise.all([readHeEngSendingAccess(db, owner), readHeEngAccountBlock(db, owner)]);
    return access.state === 'revoked' || block.state === 'blocked';
  } catch {
    return false;
  }
}

/**
 * Взять аренду живого чтения ОДНОЙ кампании прямо перед её чтением (функция
 * БД заводит строку, если её нет). true — взята; false — статус свежий или
 * аренда чужая; null — функции / таблицы нет или сбой.
 */
async function claimOne(
  db: SupabaseClient,
  projectId: string,
  campaignId: string,
  freshMs: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await db.rpc(CLAIM_RPC, {
      p_project_id: projectId,
      p_campaign_ids: [campaignId],
      p_fresh_seconds: Math.round(freshMs / 1000),
      p_lease_seconds: leaseSeconds(),
    });
    if (error) {
      warnHeEngSendingDegraded(
        isMissing(error) ? 'claim_missing' : 'claim_failed',
        pgText('he_eng_campaign_status_claim', error),
        { projectId },
      );
      return null;
    }
    return Array.isArray(data) && (data as unknown[]).includes(campaignId);
  } catch (e) {
    warnHeEngSendingDegraded('claim_failed', `he_eng_campaign_status_claim threw: ${String(e).slice(0, 200)}`, {});
    return null;
  }
}

/**
 * Пауза кампании и её подтверждение. Статус после вызова: ответ паузы, а если
 * он неясен или всё ещё «отправляет» — одно проверочное чтение. null — ни то,
 * ни другое не прочиталось (статус остаётся последним прочитанным).
 */
async function pauseAndConfirm(
  campaignId: string,
  options: { accountId: string; retryRateLimits: false; timeoutMs: number; consumer: string },
): Promise<number | null> {
  let after: number | null = null;
  try {
    const res = await pauseCampaign(campaignId, options);
    after = num(res?.status);
  } catch {
    after = null;
  }
  if (after !== null && !heEngStatusIsSending(after)) return after;
  try {
    const back = await getCampaign(campaignId, options);
    return num(back?.status);
  } catch {
    return after;
  }
}

export interface HeEngRefreshResult {
  /** Кампаний, у которых взята аренда и сделано живое чтение. */
  refreshed: number;
  failed: number;
  /**
   * Отправлявших кампаний, остановленных здесь: запуск на паузе клиента или
   * отправка аккаунта выключена сотрудником.
   */
  paused: number;
  /** Кэш недоступен (миграция) — живых чтений не было (или оборвались на нём). */
  unavailable: boolean;
}

/**
 * Живое чтение статуса и счётчиков кампаний ОДНОГО проекта в ОДНОМ воркспейсе
 * (воркспейс — пресета записи о запуске). Читает не больше `maxCampaigns`
 * (REFRESH_MAX_CAMPAIGNS) кампаний; аренду каждой берёт прямо перед её
 * чтением (claimOne), на худший случай её вызовов (leaseSeconds) — кампании,
 * которые этот вызов не читает, не арендуются. Пишет кэш и воркспейс, в
 * котором кампания нашлась. `templateOf` — шаблон кампании: у шаблона на паузе
 * клиента и у выключенного аккаунта отправляющая кампания ставится на паузу
 * (см. шапку). Причина прошлого старта (start_error) снимается, когда
 * прочитанное больше ей не соответствует: кампания завершена — любая;
 * 'needs_attention' — статус больше не отрицательный; 'not_found' и
 * 'read_failed' — кампания прочиталась; 'mailboxes_changed' — её адреса и
 * воркспейс теперь проходят проверку ящиков пула проекта (пул не прочитался —
 * причина остаётся); 'start_failed' — остаётся, пока кампания стоит.
 * ОТПРАВЛЯЮЩАЯ (по живому чтению) кампания — правило пула: её адреса не из
 * ящиков пула проекта (пул 'assigned') — 'mailboxes_changed' ставится (или
 * остаётся) на каждом таком чтении, иначе любая причина снимается; пул не
 * прочитан — прежняя 'mailboxes_changed' остаётся. По этой пометке ночной долив
 * держит строки сегмента (autoPipeline.createHeRefillSendGate). НЕ БРОСАЕТ.
 */
export async function refreshHeEngCampaignStatuses(
  db: SupabaseClient,
  args: {
    projectId: string;
    instantlyAccountId: string;
    campaignIds: string[];
    templateOf: ReadonlyMap<string, string>;
    freshMs?: number;
    maxCampaigns?: number;
  },
): Promise<HeEngRefreshResult> {
  const result: HeEngRefreshResult = { refreshed: 0, failed: 0, paused: 0, unavailable: false };
  const max = Math.min(200, Math.max(0, args.maxCampaigns ?? REFRESH_MAX_CAMPAIGNS));
  const ids = [...new Set(args.campaignIds.filter(Boolean))].slice(0, max);
  if (ids.length === 0) return result;

  const accountId = resolveInstantlyAccountId(args.instantlyAccountId);
  if (!heEngWorkspaceConfigured(accountId)) {
    // Воркспейс не настроен в окружении — читать нечем; аренды не берём.
    warnHeEngSendingDegraded('workspace_unknown', 'campaign status refresh: workspace is not configured', {
      projectId: args.projectId,
    });
    return result;
  }
  const options = {
    accountId,
    retryRateLimits: false as const,
    timeoutMs: READ_TIMEOUT_MS,
    consumer: HE_ENG_STATUS_CONSUMER,
  };
  const freshMs = args.freshMs ?? HE_ENG_STATUS_FRESH_MS;
  let ownerRevoked: Promise<boolean> | null = null;
  let assignment: ReturnType<typeof readHeSendingPoolAssignment> | null = null;
  const revokePauseFailed = new Map<string, string[]>();

  for (const campaignId of ids) {
    const claimed = await claimOne(db, args.projectId, campaignId, freshMs);
    if (claimed === null) {
      result.unavailable = true;
      break;
    }
    if (!claimed) continue;
    const prev = (await readHeEngCampaignStatusRows(db, [campaignId]))?.get(campaignId) ?? null;
    const patch: Record<string, unknown> = {};
    const now = () => new Date().toISOString();
    try {
      const live = await getCampaign(campaignId, options);
      /** Статус живого чтения — до доводки паузы ниже. */
      const liveStatus = num(live?.status);
      let status = liveStatus;
      const templateId = args.templateOf.get(campaignId) ?? null;
      if (heEngStatusIsSending(status)) {
        const clientPaused = templateId !== null && (await templateStillPaused(db, templateId));
        let revoked = false;
        if (!clientPaused) {
          ownerRevoked ??= projectOwnerRevoked(db, args.projectId);
          revoked = await ownerRevoked;
        }
        if (clientPaused || revoked) {
          const after = await pauseAndConfirm(campaignId, options);
          if (after !== null) status = after;
          if (after !== null && !heEngStatusIsSending(after)) {
            result.paused += 1;
            void logAudit(
              'he.eng_sending.reconcile_paused',
              clientPaused
                ? 'ENG campaign of a client-paused launch was sending — paused'
                : 'ENG campaign of an account with sending turned off was sending — paused',
              { projectId: args.projectId, templateId, campaignId, why: clientPaused ? 'client_paused' : 'revoked' },
            );
          } else {
            void logWarn('he.eng_sending.reconcile_pause_failed', 'pause not confirmed by the sending service', {
              projectId: args.projectId,
              templateId,
              campaignId,
              why: clientPaused ? 'client_paused' : 'revoked',
            });
            if (revoked) {
              const key = templateId ?? '';
              revokePauseFailed.set(key, [...(revokePauseFailed.get(key) ?? []), campaignId]);
            }
          }
        }
      }
      patch.status = status;
      patch.status_read_at = now();
      patch.read_error = null;
      patch.instantly_account_id = accountId;
      // Ящики пула: адреса живой кампании ⊆ ящики проекта и тот же воркспейс
      // (та же проверка, что у старта). true / false — проверено; null — пул
      // не 'assigned' или не прочитан (не решаем).
      const poolCheck = async (): Promise<boolean | null> => {
        assignment ??= readHeSendingPoolAssignment(db, args.projectId);
        const pool = await assignment;
        if (pool.kind !== 'assigned') return null;
        try {
          return checkHeCampaignAgainstAssignment(pool, {
            instantlyAccountId: accountId,
            emailList: live?.email_list,
          }).ok;
        } catch {
          return false;
        }
      };
      if (heEngStatusIsSending(liveStatus)) {
        // ПРАВИЛО ПУЛА: отправляющая кампания, чьи адреса не из ящиков пула
        // проекта, несёт 'mailboxes_changed' на каждом удачном живом чтении —
        // по этой пометке ночной долив держит строки её сегмента
        // (autoPipeline.createHeRefillSendGate). Пул не прочитан — прежняя
        // 'mailboxes_changed' остаётся, новой не ставим; прочие причины
        // снимаются: кампания отправляет.
        const ok = await poolCheck();
        if (ok === false) patch.start_error = 'mailboxes_changed';
        else if (prev?.start_error && (ok === true || prev.start_error !== 'mailboxes_changed')) patch.start_error = null;
      } else if (prev?.start_error) {
        // Не отправляет (по живому чтению).
        let stays = true;
        if (status === CampaignStatus.Completed) {
          stays = false;
        } else if (prev.start_error === 'needs_attention') {
          stays = heEngStatusIsStopped(status);
        } else if (prev.start_error === 'not_found' || prev.start_error === 'read_failed') {
          stays = false;
        } else if (prev.start_error === 'mailboxes_changed') {
          stays = (await poolCheck()) !== true;
        } else if (prev.start_error === 'start_unconfirmed') {
          // Неясный старт прочитался: стоит — старт не удался; иначе причины нет.
          stays = false;
          if (heEngStatusIsStartable(status)) patch.start_error = 'start_failed';
        }
        if (!stays && patch.start_error === undefined) patch.start_error = null;
      }
      // Счётчики — реже статуса и не чаще раза в HE_ENG_COUNTS_FRESH_MS с
      // последней ПОПЫТКИ (counts_tried_at пишется и при неудаче). Пора, когда:
      // их ещё нет; прошлая попытка не удалась; статус сейчас не тот, при
      // котором они прочитаны (counts_status — кто бы статус ни записал:
      // пауза, старт, гейт ночи или это чтение); отправляющей кампании — они
      // старше HE_ENG_COUNTS_FRESH_MS; НЕ отправляющей (стоит, завершена) —
      // старше HE_ENG_COUNTS_IDLE_MS: писем она не шлёт, но ответы на уже
      // отправленные приходят и после паузы и завершения.
      const nowMs = Date.now();
      const countsAt = prev?.counts_read_at ? Date.parse(prev.counts_read_at) : Number.NaN;
      const triedAt = prev?.counts_tried_at ? Date.parse(prev.counts_tried_at) : Number.NaN;
      const countsKnown = prev?.sent != null && prev?.replies != null && Number.isFinite(countsAt);
      const triedRecently = Number.isFinite(triedAt) && nowMs - triedAt < HE_ENG_COUNTS_FRESH_MS;
      const lastTryFailed = Number.isFinite(triedAt) && (!Number.isFinite(countsAt) || triedAt > countsAt);
      // Колонки counts_status нет (деградация) — прежнее правило: статус до чтения.
      const statusMoved = prev?.counts_status !== undefined ? prev.counts_status !== status : prev?.status !== status;
      const countsAge = nowMs - countsAt;
      const needCounts =
        !triedRecently &&
        (!countsKnown ||
          lastTryFailed ||
          statusMoved ||
          countsAge >= (heEngStatusIsSending(status) ? HE_ENG_COUNTS_FRESH_MS : HE_ENG_COUNTS_IDLE_MS));
      if (needCounts) {
        patch.counts_tried_at = now();
        try {
          const analytics = await getCampaignAnalytics({ id: campaignId }, options);
          const own = Array.isArray(analytics) ? analytics.find((a) => a?.campaign_id === campaignId) : undefined;
          const sentCount = num(own?.emails_sent_count);
          const replyCount = num(own?.reply_count_unique);
          if (sentCount !== null && replyCount !== null) {
            patch.sent = Math.max(0, Math.round(sentCount));
            patch.replies = Math.max(0, Math.round(replyCount));
            patch.counts_read_at = now();
            patch.counts_status = status;
          }
        } catch {
          // Статус прочитан; счётчики остаются прежними со своим временем.
        }
      }
      patch.refresh_until = null;
      result.refreshed += 1;
    } catch (e) {
      const notFound = e instanceof InstantlyApiError && e.status === 404;
      patch.read_error = notFound ? 'not_found' : 'failed';
      patch.refresh_until = new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString();
      result.failed += 1;
    }
    try {
      const write = (p: Record<string, unknown>) =>
        db.from(HE_ENG_CAMPAIGN_STATUS_TABLE).update(p).eq('campaign_id', campaignId).eq('project_id', args.projectId);
      let { error } = await write(patch);
      // Кэш первой редакции миграции — без поздних колонок (LEGACY_ROW_COLUMNS).
      if (isColumnMissing(error)) ({ error } = await write(withoutLateColumns(patch)));
      if (error) warnHeEngSendingDegraded('status_write', pgText('he_eng_campaign_status update', error), {});
    } catch (e) {
      warnHeEngSendingDegraded('status_write', `he_eng_campaign_status update threw: ${String(e).slice(0, 200)}`, {});
    }
  }
  for (const [templateId, campaignIds] of revokePauseFailed) {
    void notifyHeEngSending({
      kind: 'revoke_pause_failed',
      projectId: args.projectId,
      templateId: templateId || null,
      campaignIds,
      where: 'status_read',
    });
  }
  return result;
}
