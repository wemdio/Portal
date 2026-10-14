/**
 * ENG: заблокированный аккаунт в воркере движка (S3b; решение владельца
 * 12.10.2026: «если бан, то всё нужно останавливать и блокировать»).
 *
 * Блокировка в карточке ENG-клиента (engAccountBlock) один раз останавливает
 * всё, что видит: выключает отправку аккаунта, гасит джобы и базы, ставит
 * кампании на паузу и ПЕРВЫМ шагом пишет отметку блокировки
 * (he_eng_account_blocks). Этот модуль — то, что держит её дальше, в воркере
 * движка (worker/hypothesisEngine.ts). Две части.
 *
 * 1. СТРАЖ ДЖОБЫ (guardHeEngJobOwner) — на каждом клейме джобы us-проекта, до
 *    стадии. Читает отметку владельца проекта (одно чтение по ключу; RU-джобы
 *    её не читают вовсе):
 *     - 'blocked' — джоба 'running' → 'cancelled' условной записью по токену
 *       клейма (started_at), стадия НЕ запускается; база стадии base_collect /
 *       base_analyze закрывается как отменой ('failed' «Cancelled by user»,
 *       только когда по ней нет другой живой джобы), её дочерние джобы
 *       конструктора и Google Maps останавливаются
 *       (engProjectStop.stopHeBaseWorkForCancelledBase); стадия исследования
 *       возвращает проект из 'researching' в 'draft' — то же, что делает с
 *       проектом сама блокировка. Так останавливается всё, что встало в
 *       очередь после блокировки или вернулось в неё: возврат после рестарта,
 *       сборщик брошенных строк, ожидание дочерних парсеров сборкой, поздняя
 *       постановка;
 *     - отметка не прочиталась — стадия НЕ запускается, попытка НЕ тратится,
 *       и горячего цикла нет: джоба возвращается в 'pending' с run_after
 *       через HE_ENG_JOB_BLOCK_READ_RETRY_MS (разовый сбой) или
 *       HE_ENG_JOB_BLOCK_READ_PERSISTENT_RETRY_MS (постоянный: например,
 *       42501 — нет прав), без счётчика прерываний. Строка лога — одна на
 *       окно RELEASE_LOG_WINDOW_MS (с числом возвратов за прошлое окно);
 *       постоянный сбой ещё и алерт команде 'block_marker_unreadable'
 *       (engSendingAlert: раз в час на код сбоя — что стоит и какие права
 *       проверить); воркер тем временем берёт другие джобы. Возврат не лёг —
 *       'not_released': воркер отдаёт джобу своей политике прерываний
 *       (бесплатно до пяти подряд) — это тот же случай, что сбой чтения
 *       проекта до стадии: БД не отвечает;
 *     - таблицы нет (миграция 20261013_0001) — стадия идёт как до S3b (одну
 *       строку warn на процесс пишет читатель отметки).
 *    Бан Supabase без отметки (поставленный мимо карточки) этот страж НЕ
 *    видит: чтение пользователя в Supabase Auth на каждом клейме было бы
 *    дороже самой проверки. Такой бан держат пути, которые ставят новую
 *    платную работу: дочейн автопилота, ночной добор, повторный старт
 *    завершённой кампании, гейт платных шагов и автозапуск
 *    (autopilotNext.readHeEngOwnerHold, engAutoLaunch.readHeEngAccountStanding);
 *    уже стоящие в очереди джобы такого аккаунта дорабатывают. Карточка
 *    клиента показывает «бан без остановки» — «Заблокировать ещё раз» пишет
 *    отметку.
 *
 * 2. ФОНОВАЯ ПРОВЕРКА (runHeEngBlockedSweep / createHeEngBlockSweepTicker) —
 *    между джобами, не чаще раза в HE_ENG_BLOCK_SWEEP_MS (дефолт 5 мин),
 *    независимо от HE_ENG_AUTO_LAUNCH; выключатель HE_ENG_BLOCK_SWEEP=0. Нет
 *    активных отметок — один запрос, и всё. Есть:
 *     a) выключатель отправки каждого заблокированного аккаунта (не больше
 *        HE_ENG_BLOCK_SWEEP_MAX_ACCOUNTS за прогон, по кругу): не 'revoked' —
 *        отметка аккаунта перечитывается, и только если она всё ещё активна,
 *        выключатель выключается снова (setHeEngSendingAccess(false)) со
 *        строкой error в логе: разблокировка и «Включить отправку», пришедшие
 *        после чтения списка, не отменяются (включение отказывается, пока
 *        отметка активна, — остаётся только окно между этим перечитыванием и
 *        записью). Отметка не перечиталась — аккаунт пропускается до
 *        следующего прогона (гейты старта и долива читают её сами и при сбое
 *        отказывают). Держит правило «заблокирован ⇒ отправка выключена», на
 *        котором стоят все гейты старта и долива;
 *     b) кампании их us-запусков — живое чтение статуса
 *        (engCampaignStatus.refreshHeEngCampaignStatuses: общий ограничитель
 *        воркспейса, без повторов на 429, аренда строки на каждую кампанию).
 *        Отправляющую кампанию выключенного аккаунта оно ставит на паузу и
 *        подтверждает статусом; не подтвердилась — алерт команде
 *        ('revoke_pause_failed', where 'status_read'). Пауза засчитывается
 *        только по прочитанному неотправляющему статусу. Пора читать
 *        (heEngBlockSweepDue): строки кэша нет или статус не читался; кэш
 *        говорит «отправляет»; статус прочитан раньше последнего нажатия
 *        «Заблокировать» (читается с freshMs 0); прошлое чтение не удалось;
 *        статус старше HE_ENG_BLOCK_SWEEP_RECHECK_MS (30 мин) — так
 *        ловится кампания, которую кто-то запустил руками у рассыльщика.
 *        Удалённая у рассыльщика кампания (read_error 'not_found'): «404»
 *        мог прочитать и не этот прогон, и не в том воркспейсе (сводка
 *        кабинета читает в воркспейсе пресета). Поэтому процесс помнит, где
 *        сам прочитал «404»: прочитал в воркспейсе удачного чтения
 *        (instantly_account_id строки) — больше её не читает; иначе — не
 *        чаще раза в 24 ч на процесс, в воркспейсе удачного чтения, если он
 *        записан и настроен. После рестарта процесса — одно чтение на такую
 *        кампанию, самым последним по срочности. Не больше
 *        HE_ENG_BLOCK_SWEEP_MAX_CAMPAIGNS за прогон, срочные первыми
 *        (отправляющие, не читавшиеся, старые).
 *    Список отметок не прочитался постоянным сбоем (не блип) — алерт
 *    команде 'block_marker_unreadable' (раз в час на код), прогон кончается.
 *    ЦЕНА ДЛЯ ОЧЕРЕДИ (воркер один на оба рынка): прогон держит очередь не
 *    дольше HE_ENG_BLOCK_SWEEP_BUDGET_MS (20 с) — дальше воркер берёт
 *    джобы, а прогон доходит фоном; новый прогон не начинается, пока старый
 *    не кончился, и новых кампаний прогон не начинает после
 *    START_CUTOFF_MS. Пока идёт длинная стадия, проверки нет: она только
 *    между джобами.
 *    СРОК ДОГОНЯЮЩЕЙ ПАУЗЫ для кампании, запущенной руками после блокировки:
 *    до 30 мин (перечитывание) + 5 мин (период) + время текущей стадии
 *    воркера, при числе срочных кампаний всех заблокированных не больше 10;
 *    больше — по кругу, по 10 за прогон.
 *
 * НЕ БРОСАЕТ: каждая функция отвечает значением.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isTransientDbError } from '@/lib/db/transientError';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit } from '@/lib/loggerServer';
import { HE_ENG_ACCOUNT_BLOCKS_TABLE, readHeEngAccountBlock, type HeEngAccountBlockState } from './engAccountBlockMarker';
import { HE_ENG_CANCELLED_BASE_ERROR, stopHeBaseWorkForCancelledBase } from './engProjectStop';
import { liveHeJobBaseIds } from './autopilotNext';
import { HE_RESEARCH_STAGES } from './researchJob';
import {
  heEngLaunchCampaigns,
  heEngStatusIsSending,
  heEngWorkspaceConfigured,
  readHeEngCampaignStatusRows,
  refreshHeEngCampaignStatuses,
  type HeEngCampaignStatusRow,
  type HeEngRefreshResult,
} from './engCampaignStatus';
import { readHeEngSendingAccess, setHeEngSendingAccess } from './engSendingAccess';
import { notifyHeEngSending } from './engSendingAlert';
import { readHeSendingPoolAssignment } from './sendingPool';
import { parseLaunchInfo } from './launchHandoff';
import type { HeJob } from './types';

export type HeEngSweepLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

/* ═══════════════ 1. Страж джобы ═══════════════ */

/** Отметка не прочиталась разово (обрыв, блип) — повтор джобы не раньше. */
export const HE_ENG_JOB_BLOCK_READ_RETRY_MS = 60_000;
/** Отметка не читается постоянно (нет прав, кеш схемы) — повтор не раньше. */
export const HE_ENG_JOB_BLOCK_READ_PERSISTENT_RETRY_MS = 15 * 60_000;
/** Одна строка лога о возвратах джоб на окно (на вид сбоя). */
const RELEASE_LOG_WINDOW_MS = 10 * 60_000;

export type HeEngJobGuardVerdict =
  | { kind: 'run' }
  | { kind: 'blocked' }
  | { kind: 'unread'; transient: boolean; detail: string; code: string | null };

/**
 * Решение по прочитанной отметке: 'blocked' — гасить, 'unread' — вернуть в
 * очередь с паузой, 'run' — стадия идёт ('clear' и нет таблицы).
 * Брошенное чтение (code null) — разовый сбой.
 */
export function heEngJobGuardVerdict(read: HeEngAccountBlockState): HeEngJobGuardVerdict {
  switch (read.state) {
    case 'blocked':
      return { kind: 'blocked' };
    case 'error':
      return {
        kind: 'unread',
        transient: read.code === null || isTransientDbError({ code: read.code, message: read.detail }),
        detail: read.detail,
        code: read.code,
      };
    case 'clear':
    case 'missing':
      return { kind: 'run' };
  }
}

export type HeEngJobGuardOutcome =
  /** Владелец не заблокирован (или таблицы нет) — стадия идёт. */
  | 'run'
  /** Владелец заблокирован: джоба погашена этим стражем, стадия не идёт. */
  | 'cancelled'
  /**
   * Строку уже закрыли без нас (отмена, другой прогон) — стадия не идёт,
   * ничего не пишем.
   */
  | 'closed'
  /** Отметка не прочиталась: джоба снова 'pending' с run_after, стадия не идёт. */
  | 'released'
  /** Отметка не прочиталась и возврат не лёг: воркер решает политикой прерываний. */
  | 'not_released';

const releaseLogged = new Map<string, { at: number; suppressed: number }>();

function logReleaseOnce(log: HeEngSweepLog, key: string, msg: string): void {
  const now = Date.now();
  const entry = releaseLogged.get(key);
  if (entry && now - entry.at < RELEASE_LOG_WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }
  if (releaseLogged.size >= 50) releaseLogged.clear();
  releaseLogged.set(key, { at: now, suppressed: 0 });
  const more = entry && entry.suppressed > 0 ? ` (ещё ${entry.suppressed} таких возвратов за прошлое окно)` : '';
  log('error', `${msg}${more}`);
}

/**
 * Записать строку джобы условно: 'running' ЭТОГО прогона (токен клейма
 * started_at, у строки без токена — `started_at is null`) — тот же контракт,
 * что у done- и fail-записей воркера. Число задетых строк; null — запись
 * отказала.
 */
async function writeOwnRun(db: SupabaseClient, job: HeJob, patch: Record<string, unknown>): Promise<number | null> {
  try {
    const write = db.from('he_jobs').update(patch).eq('id', job.id).eq('status', 'running');
    const { data, error } = await (job.started_at
      ? write.eq('started_at', job.started_at)
      : write.is('started_at', null)
    ).select('id');
    if (error) return null;
    return (data ?? []).length;
  } catch {
    return null;
  }
}

/** Вернуть джобу в очередь с паузой (попытка и счётчик прерываний — как были). */
async function releaseJob(
  db: SupabaseClient,
  job: HeJob,
  delayMs: number,
  now: Date,
): Promise<'released' | 'closed' | 'not_released'> {
  const landed = await writeOwnRun(db, job, {
    status: 'pending',
    started_at: null,
    run_after: new Date(now.getTime() + delayMs).toISOString(),
    updated_at: now.toISOString(),
  });
  if (landed === null) return 'not_released';
  return landed > 0 ? 'released' : 'closed';
}

/**
 * Страж джобы us-проекта (часть 1 шапки). `ownerUserId` — he_projects.created_by
 * (пусто — отметки быть не может, 'run'). НЕ БРОСАЕТ.
 */
export async function guardHeEngJobOwner(
  db: SupabaseClient,
  job: HeJob,
  ownerUserId: string,
  opts: { log: HeEngSweepLog; now?: Date },
): Promise<HeEngJobGuardOutcome> {
  const now = opts.now ?? new Date();
  const verdict = heEngJobGuardVerdict(await readHeEngAccountBlock(db, ownerUserId));
  if (verdict.kind === 'run') return 'run';

  if (verdict.kind === 'unread') {
    const delayMs = verdict.transient ? HE_ENG_JOB_BLOCK_READ_RETRY_MS : HE_ENG_JOB_BLOCK_READ_PERSISTENT_RETRY_MS;
    if (!verdict.transient) {
      // Постоянный сбой (код есть: брошенное чтение — блип) — команде, раз в
      // час на код (дедупликация — в notifyHeEngSending).
      void notifyHeEngSending({
        kind: 'block_marker_unreadable',
        code: verdict.code ?? 'unknown',
        detail: verdict.detail,
        where: 'job_guard',
      });
    }
    const released = await releaseJob(db, job, delayMs, now);
    logReleaseOnce(
      opts.log,
      verdict.transient ? 'transient' : `persistent:${verdict.code ?? ''}`,
      `[eng-block] отметка блокировки владельца не прочиталась (${verdict.detail}) — джоба ${job.id} (${job.stage}) `
        + `${released === 'released' ? `возвращена в очередь на ${Math.round(delayMs / 1000)} с, попытка не потрачена` : released === 'closed' ? 'уже закрыта без воркера' : 'НЕ возвращена (запись не легла) — идёт политикой прерываний'}`
        + `${verdict.transient ? '' : ' — сбой постоянный: проверьте права на he_eng_account_blocks'}`,
    );
    return released;
  }

  // Заблокирован: погасить строку этого прогона (та же запись, что у
  // остановки проекта блокировкой — engProjectStop, шаг «джобы»).
  const nowIso = now.toISOString();
  const cancelled = await writeOwnRun(db, job, { status: 'cancelled', finished_at: nowIso, updated_at: nowIso });
  if (cancelled === 0) return 'closed';
  if (cancelled === null) {
    // Погасить не удалось — стадию всё равно не запускаем: назад в очередь, и
    // следующий клейм попробует снова.
    const released = await releaseJob(db, job, HE_ENG_JOB_BLOCK_READ_RETRY_MS, now);
    opts.log(
      'error',
      `[eng-block] джоба ${job.id} (${job.stage}) заблокированного аккаунта не погашена (запись отказала) — `
        + `${released === 'released' ? 'возвращена в очередь, стадия не запускалась' : released === 'closed' ? 'строка уже закрыта без воркера' : 'возврат тоже не лёг — идёт политикой прерываний'}`,
    );
    return released;
  }

  const notes: string[] = [];
  const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
  if ((job.stage === 'base_collect' || job.stage === 'base_analyze') && baseId) {
    notes.push(await closeOwnBase(db, job, baseId, now));
  }
  if (HE_RESEARCH_STAGES.includes(job.stage)) {
    try {
      const { data, error } = await db
        .from('he_projects')
        .update({ status: 'draft', error: null, updated_at: nowIso })
        .eq('id', job.project_id)
        .eq('status', 'researching')
        .select('id');
      notes.push(error ? `исследование не возвращено в draft (${error.message})` : (data ?? []).length > 0 ? 'исследование → draft' : 'исследование не шло');
    } catch (e) {
      notes.push(`исследование не возвращено в draft (${e instanceof Error ? e.message : 'threw'})`);
    }
  }
  opts.log(
    'warn',
    `[eng-block] джоба ${job.id} (${job.stage}) проекта ${job.project_id}: владелец заблокирован — `
      + `погашена, стадия не запускалась${notes.length ? `; ${notes.join('; ')}` : ''}`,
  );
  void logAudit('he.eng_block.job_cancelled', 'ENG job of a blocked account cancelled before its stage', {
    jobId: job.id,
    stage: job.stage,
    projectId: job.project_id,
    userId: ownerUserId,
    notes: notes.join('; ').slice(0, 500),
  });
  return 'cancelled';
}

/**
 * База стадии погашенной джобы — как при отмене: 'collecting'/'analyzing' →
 * 'failed' «Cancelled by user», только если по ней нет другой живой джобы
 * (она сама придёт к стражу), затем дочерние джобы конструктора и Google Maps.
 * Сбой — строка в ответе (лог), ничего не бросает.
 */
async function closeOwnBase(db: SupabaseClient, job: HeJob, baseId: string, now: Date): Promise<string> {
  let closed: string;
  try {
    const live = await liveHeJobBaseIds(db, job.project_id);
    if (live.has(baseId)) {
      closed = `база ${baseId}: по ней есть другая живая джоба — не трогаем`;
    } else {
      const { data, error } = await db
        .from('he_bases')
        .update({ status: 'failed', error: HE_ENG_CANCELLED_BASE_ERROR, updated_at: now.toISOString() })
        .eq('id', baseId)
        .eq('project_id', job.project_id)
        .in('status', ['collecting', 'analyzing'])
        .select('id');
      closed = error
        ? `база ${baseId} не закрыта (${error.message})`
        : (data ?? []).length > 0
          ? `база ${baseId} → failed`
          : `база ${baseId} уже не в работе`;
    }
  } catch (e) {
    closed = `база ${baseId} не закрыта (${e instanceof Error ? e.message : 'threw'})`;
  }
  const children = await stopHeBaseWorkForCancelledBase(db, baseId, now);
  const childText =
    children.base === 'cancelled'
      ? `дочерних джоб остановлено: конструктор ${children.constructorJobs}, Google Maps ${children.mapsJobs}${children.failed ? ' (часть записей отказала)' : ''}`
      : children.base === 'failed'
        ? 'дочерние джобы не остановлены (чтение базы не удалось)'
        : 'дочерние джобы не трогали (база не отменена)';
  return `${closed}; ${childText}`;
}

/* ═══════════════ 2. Фоновая проверка ═══════════════ */

export const HE_ENG_BLOCK_SWEEP_ENV = 'HE_ENG_BLOCK_SWEEP';
export const HE_ENG_BLOCK_SWEEP_MS_ENV = 'HE_ENG_BLOCK_SWEEP_MS';
export const HE_ENG_BLOCK_SWEEP_MS_DEFAULT = 5 * 60_000;
/** Сколько заблокированных аккаунтов прогон берёт (по кругу). */
export const HE_ENG_BLOCK_SWEEP_MAX_ACCOUNTS = 20;
/** Сколько кампаний прогон читает. */
export const HE_ENG_BLOCK_SWEEP_MAX_CAMPAIGNS = 10;
/**
 * Неотправляющая кампания заблокированного перечитывается не реже. Столько же
 * разблокировка (engAccountBlock) верит прочитанной паузе: кампанию, чей не
 * отправляющий статус прочитан после последнего «Заблокировать» и не раньше
 * этого срока, она второй раз на паузу не ставит.
 */
export const HE_ENG_BLOCK_SWEEP_RECHECK_MS = 30 * 60_000;
/** 'not_found', который этот процесс не прочитал сам в воркспейсе удачного чтения, — не чаще (на процесс). */
export const HE_ENG_BLOCK_SWEEP_NOT_FOUND_RETRY_MS = 24 * 60 * 60_000;
/** Сколько прогон держит очередь воркера; дальше он доходит фоном. */
export const HE_ENG_BLOCK_SWEEP_BUDGET_MS = 20_000;
/** После этого новых кампаний прогон не начинает. */
const START_CUTOFF_MS = 15_000;
/** Отметок за одно чтение (больше — строка warn, остальные ждут). */
const MARKERS_READ_LIMIT = 1000;
const ID_CHUNK = 100;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

export function heEngBlockSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF_VALUES.has((env[HE_ENG_BLOCK_SWEEP_ENV] ?? '').trim().toLowerCase());
}

/** Период проверки (мс): число ≥ 60 000 из переменной, иначе дефолт. */
export function heEngBlockSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[HE_ENG_BLOCK_SWEEP_MS_ENV]);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : HE_ENG_BLOCK_SWEEP_MS_DEFAULT;
}

/** Кампания запуска заблокированного аккаунта. */
export interface HeEngSweepCampaign {
  campaignId: string;
  projectId: string;
  templateId: string;
  ownerUserId: string;
  presetId: string;
  /** Последнее нажатие «Заблокировать» (мс). */
  lastBlockAtMs: number;
}

/**
 * Пора ли читать кампанию (часть 2b шапки). Число — срочность (меньше —
 * раньше), null — не сейчас. `notFoundTriedAtMs` — когда этот процесс
 * последний раз читал её строку 'not_found'; `notFoundReadIn` — воркспейс
 * удачного чтения (instantly_account_id строки), в котором этот процесс сам
 * прочитал её «404»: совпадает с нынешним — кампании там нет, больше не
 * читаем.
 */
export function heEngBlockSweepDue(
  row: HeEngCampaignStatusRow | undefined,
  lastBlockAtMs: number,
  nowMs: number,
  notFoundTriedAtMs: number | undefined,
  notFoundReadIn?: string,
): number | null {
  if (!row) return 1;
  const lease = row.refresh_until ? Date.parse(row.refresh_until) : Number.NaN;
  if (Number.isFinite(lease) && lease > nowMs) return null;
  if (row.read_error === 'not_found') {
    if (row.instantly_account_id && notFoundReadIn === row.instantly_account_id) return null;
    if (notFoundTriedAtMs !== undefined && nowMs - notFoundTriedAtMs < HE_ENG_BLOCK_SWEEP_NOT_FOUND_RETRY_MS) return null;
    return 4;
  }
  if (heEngStatusIsSending(row.status)) return 0;
  const readAt = row.status_read_at ? Date.parse(row.status_read_at) : Number.NaN;
  if (!Number.isFinite(readAt)) return 1;
  if (readAt < lastBlockAtMs) return 1;
  if (row.read_error === 'failed') return 2;
  if (nowMs - readAt >= HE_ENG_BLOCK_SWEEP_RECHECK_MS) return 3;
  return null;
}

export interface HeEngBlockSweepReport {
  /** Таблица отметок: 'missing' — миграции нет, 'error' — не прочиталась. */
  markers: 'ok' | 'missing' | 'error';
  /** Активных отметок всего / взято этим прогоном. */
  blocked: number;
  accounts: number;
  /** Выключатель отправки был не выключен — выключен снова / не удалось. */
  switchReasserted: number;
  switchFailed: number;
  /** Не выключен снова: отметку сняли после чтения списка (перечитана перед записью). */
  switchSkipped: number;
  /** Запуски не прочитались — кампании этим прогоном не читались. */
  launchesUnread: boolean;
  campaigns: number;
  due: number;
  /** Кампаний, отданных живому чтению. */
  attempted: number;
  refreshed: number;
  paused: number;
  failed: number;
  /** Воркспейс кампании неизвестен — читать нечем. */
  noWorkspace: number;
  /** Срочные, до которых прогон не дошёл (лимит, срок, остановка воркера). */
  notStarted: number;
}

export interface HeEngBlockSweepDeps {
  refresh?: typeof refreshHeEngCampaignStatuses;
  setAccess?: typeof setHeEngSendingAccess;
  readAccess?: typeof readHeEngSendingAccess;
  readMarker?: typeof readHeEngAccountBlock;
  readPool?: typeof readHeSendingPoolAssignment;
  workspaceConfigured?: (accountId: string) => boolean;
}

/** Курсор круга по аккаунтам (на процесс). */
let accountCursor = '';
/** campaign_id → когда этот процесс читал её строку 'not_found'. */
const notFoundTriedAt = new Map<string, number>();
/**
 * campaign_id → воркспейс удачного чтения (instantly_account_id строки), в
 * котором этот процесс сам прочитал «404».
 */
const notFoundReadIn = new Map<string, string>();
let missingWarned = false;
/** Заблокированные аккаунты, переставшие быть ENG-клиентами (строка warn — раз на процесс). */
const notClientWarned = new Set<string>();

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function emptyReport(): HeEngBlockSweepReport {
  return {
    markers: 'ok',
    blocked: 0,
    accounts: 0,
    switchReasserted: 0,
    switchFailed: 0,
    switchSkipped: 0,
    launchesUnread: false,
    campaigns: 0,
    due: 0,
    attempted: 0,
    refreshed: 0,
    paused: 0,
    failed: 0,
    noWorkspace: 0,
    notStarted: 0,
  };
}

/** Чтение `.in()` пачками; сбой любой пачки — null. */
async function readIn(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Array<Record<string, unknown>> | null> {
  const rows: Array<Record<string, unknown>> = [];
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const { data, error } = await read(chunk);
    if (error) return null;
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return rows;
}

/**
 * Один прогон фоновой проверки (часть 2 шапки). Ждать его целиком воркеру не
 * нужно — см. createHeEngBlockSweepTicker. НЕ БРОСАЕТ.
 */
export async function runHeEngBlockedSweep(opts: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log: HeEngSweepLog;
  shouldStop?: () => boolean;
  now?: () => number;
  deps?: HeEngBlockSweepDeps;
}): Promise<HeEngBlockSweepReport> {
  const db = opts.portalDb;
  const clock = opts.now ?? (() => Date.now());
  const startedMs = clock();
  const deps = opts.deps ?? {};
  const refresh = deps.refresh ?? refreshHeEngCampaignStatuses;
  const setAccess = deps.setAccess ?? setHeEngSendingAccess;
  const readAccess = deps.readAccess ?? readHeEngSendingAccess;
  const readMarker = deps.readMarker ?? readHeEngAccountBlock;
  const readPool = deps.readPool ?? readHeSendingPoolAssignment;
  const workspaceConfigured = deps.workspaceConfigured ?? heEngWorkspaceConfigured;
  const report = emptyReport();
  try {
    // 1. Активные отметки.
    const { data: markerRows, error: markerErr } = await db
      .from(HE_ENG_ACCOUNT_BLOCKS_TABLE)
      .select('user_id, last_block_at')
      .eq('active', true)
      .order('user_id', { ascending: true })
      .limit(MARKERS_READ_LIMIT);
    if (markerErr) {
      const code = (markerErr as { code?: string }).code ?? '';
      if (code === '42P01' || code === 'PGRST205') {
        report.markers = 'missing';
        if (!missingWarned) {
          missingWarned = true;
          opts.log('warn', '[eng-block-sweep] he_eng_account_blocks is missing (migration 20261013_0001) — проверка заблокированных не идёт');
        }
      } else {
        report.markers = 'error';
        const message = String((markerErr as { message?: string }).message ?? '').slice(0, 200);
        opts.log('warn', `[eng-block-sweep] отметки блокировки не прочитаны: ${code} ${message}`);
        // Постоянный сбой (не блип; без кода — блип, как у стража джобы) —
        // команде, раз в час на код: стоят и джобы, и платные шаги кабинета.
        if (code && !isTransientDbError({ code, message })) {
          void notifyHeEngSending({
            kind: 'block_marker_unreadable',
            code,
            detail: `he_eng_account_blocks list read: ${code} ${message}`,
            where: 'sweep',
          });
        }
      }
      return report;
    }
    const markers = ((markerRows ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({ userId: str(r.user_id), lastBlockAtMs: Date.parse(str(r.last_block_at)) }))
      .filter((m) => m.userId.length > 0)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    report.blocked = markers.length;
    if (markers.length === 0) return report;
    if (markers.length >= MARKERS_READ_LIMIT) {
      opts.log('warn', `[eng-block-sweep] активных отметок не меньше ${MARKERS_READ_LIMIT} — проверка видит только первые`);
    }

    // По кругу: следующие после курсора, затем с начала.
    const after = markers.filter((m) => m.userId > accountCursor);
    const ordered = [...after, ...markers.filter((m) => m.userId <= accountCursor)];
    const taken = ordered.slice(0, HE_ENG_BLOCK_SWEEP_MAX_ACCOUNTS);
    accountCursor = taken[taken.length - 1]?.userId ?? '';
    report.accounts = taken.length;

    // 2a. Выключатель отправки: заблокирован ⇒ выключен.
    for (const m of taken) {
      if (opts.shouldStop?.()) return report;
      const access = await readAccess(db, m.userId, { skipEnv: true });
      if (access.state === 'revoked') continue;
      if (access.state === 'not_client') {
        if (!notClientWarned.has(m.userId)) {
          notClientWarned.add(m.userId);
          opts.log('warn', `[eng-block-sweep] аккаунт ${m.userId} заблокирован, но он больше не ENG-клиент — выключатель отправки к нему не применяется`);
        }
        report.switchFailed += 1;
        continue;
      }
      if (access.state === 'error' || access.state === 'unavailable') {
        report.switchFailed += 1;
        opts.log('warn', `[eng-block-sweep] выключатель отправки аккаунта ${m.userId} не прочитан: ${access.detail ?? access.state}`);
        continue;
      }
      // Отметку — ещё раз прямо перед записью: разблокировку и «Включить
      // отправку» после чтения списка не отменяем.
      const marker = await readMarker(db, m.userId);
      if (marker.state === 'clear') {
        report.switchSkipped += 1;
        opts.log('info', `[eng-block-sweep] аккаунт ${m.userId} разблокирован после чтения списка — отправку не выключаем`);
        continue;
      }
      if (marker.state !== 'blocked') {
        report.switchFailed += 1;
        opts.log('warn', `[eng-block-sweep] отметка аккаунта ${m.userId} не перечиталась перед выключением отправки — пропущен до следующего прогона: ${marker.detail}`);
        continue;
      }
      const set = await setAccess(db, m.userId, false);
      if (set.kind === 'updated') {
        report.switchReasserted += 1;
        opts.log(
          'error',
          `[eng-block-sweep] аккаунт ${m.userId} заблокирован, а отправка была '${access.state}' — выключена снова`,
        );
      } else {
        report.switchFailed += 1;
        opts.log('error', `[eng-block-sweep] отправку заблокированного аккаунта ${m.userId} выключить не удалось: ${set.kind}`);
      }
    }

    // 2b. Кампании us-запусков этих аккаунтов.
    const lastBlockOf = new Map(taken.map((m) => [m.userId, Number.isFinite(m.lastBlockAtMs) ? m.lastBlockAtMs : 0]));
    const projects = await readIn([...lastBlockOf.keys()], (chunk) =>
      db.from('he_projects').select('id, created_by').in('created_by', chunk).eq('market', 'us'),
    );
    const ownerOf = new Map((projects ?? []).map((p) => [str(p.id), str(p.created_by)]));
    const verticals = projects === null ? null : await readIn([...ownerOf.keys()], (chunk) =>
      db.from('he_verticals').select('id, project_id').in('project_id', chunk),
    );
    const projectOfVertical = new Map((verticals ?? []).map((v) => [str(v.id), str(v.project_id)]));
    const templates = verticals === null ? null : await readIn([...projectOfVertical.keys()], (chunk) =>
      db.from('he_templates').select('id, vertical_id, launch_info').in('vertical_id', chunk).not('launch_info', 'is', null),
    );
    if (templates === null) {
      report.launchesUnread = true;
      opts.log('warn', '[eng-block-sweep] запуски заблокированных аккаунтов не прочитаны — кампании этим прогоном не читаются');
      return report;
    }
    const campaigns: HeEngSweepCampaign[] = [];
    for (const t of templates) {
      const launch = parseLaunchInfo(t.launch_info);
      const projectId = projectOfVertical.get(str(t.vertical_id)) ?? '';
      const ownerUserId = ownerOf.get(projectId) ?? '';
      if (!launch || !projectId || !ownerUserId) continue;
      for (const c of heEngLaunchCampaigns(launch)) {
        campaigns.push({
          campaignId: c.campaignId,
          projectId,
          templateId: str(t.id),
          ownerUserId,
          presetId: launch.preset_id,
          lastBlockAtMs: lastBlockOf.get(ownerUserId) ?? 0,
        });
      }
    }
    report.campaigns = campaigns.length;
    if (campaigns.length === 0) return report;
    const rows = await readHeEngCampaignStatusRows(db, campaigns.map((c) => c.campaignId));
    if (rows === null) {
      report.launchesUnread = true;
      return report;
    }
    const nowMs = clock();
    const due = campaigns
      .map((c) => {
        const row = rows.get(c.campaignId);
        const urgency = heEngBlockSweepDue(
          row,
          c.lastBlockAtMs,
          nowMs,
          notFoundTriedAt.get(c.campaignId),
          notFoundReadIn.get(c.campaignId),
        );
        const readAt = row?.status_read_at ? Date.parse(row.status_read_at) : 0;
        return { c, row, urgency, readAt: Number.isFinite(readAt) ? readAt : 0 };
      })
      .filter((d): d is typeof d & { urgency: number } => d.urgency !== null)
      .sort((a, b) => a.urgency - b.urgency || a.readAt - b.readAt);
    report.due = due.length;

    // Воркспейс: где кампания нашлась при удачном чтении, иначе пресета записи
    // о запуске (пресет самого владельца), иначе ящиков пула проекта.
    const presetWorkspace = new Map<string, string | null>();
    const poolWorkspace = new Map<string, string | null>();
    const workspaceOf = async (d: (typeof due)[number]): Promise<string | null> => {
      const recorded = d.row?.instantly_account_id;
      if (recorded && workspaceConfigured(recorded)) return resolveInstantlyAccountId(recorded);
      const presetKey = `${d.c.ownerUserId}|${d.c.presetId}`;
      if (!presetWorkspace.has(presetKey)) {
        let ws: string | null = null;
        if (opts.instantlyDb && d.c.presetId) {
          const { data, error } = await opts.instantlyDb
            .from('client_campaign_presets')
            .select('instantly_account_id')
            .eq('id', d.c.presetId)
            .eq('client_user_id', d.c.ownerUserId)
            .maybeSingle();
          const raw = error ? '' : str((data as { instantly_account_id?: unknown } | null)?.instantly_account_id);
          if (raw && workspaceConfigured(raw)) ws = resolveInstantlyAccountId(raw);
        }
        presetWorkspace.set(presetKey, ws);
      }
      const fromPreset = presetWorkspace.get(presetKey) ?? null;
      if (fromPreset) return fromPreset;
      if (!poolWorkspace.has(d.c.projectId)) {
        const pool = await readPool(db, d.c.projectId);
        poolWorkspace.set(
          d.c.projectId,
          pool.kind === 'assigned' && workspaceConfigured(pool.instantlyAccountId)
            ? resolveInstantlyAccountId(pool.instantlyAccountId)
            : null,
        );
      }
      return poolWorkspace.get(d.c.projectId) ?? null;
    };

    for (const [i, d] of due.entries()) {
      if (
        report.attempted >= HE_ENG_BLOCK_SWEEP_MAX_CAMPAIGNS
        || clock() - startedMs >= START_CUTOFF_MS
        || opts.shouldStop?.()
      ) {
        report.notStarted = due.length - i;
        break;
      }
      const accountId = await workspaceOf(d);
      if (!accountId) {
        report.noWorkspace += 1;
        opts.log('warn', `[eng-block-sweep] кампания ${d.c.campaignId} (проект ${d.c.projectId}): воркспейс неизвестен — не читаем`);
        continue;
      }
      if (d.row?.read_error === 'not_found') notFoundTriedAt.set(d.c.campaignId, clock());
      report.attempted += 1;
      let res: HeEngRefreshResult;
      try {
        res = await refresh(db, {
          projectId: d.c.projectId,
          instantlyAccountId: accountId,
          campaignIds: [d.c.campaignId],
          templateOf: new Map([[d.c.campaignId, d.c.templateId]]),
          freshMs: 0,
          maxCampaigns: 1,
        });
      } catch {
        res = { refreshed: 0, failed: 1, paused: 0, unavailable: false };
      }
      report.refreshed += res.refreshed;
      report.failed += res.failed;
      report.paused += res.paused;
      // Прочитано ли «404» этим чтением в воркспейсе удачного чтения строки
      // (workspaceOf берёт его первым, когда он настроен) — по строке кэша
      // сразу после чтения (refresh пишет read_error 'not_found' только на 404).
      const recordedWs = d.row?.instantly_account_id;
      if (res.failed > 0 && recordedWs && workspaceConfigured(recordedWs)) {
        const after = (await readHeEngCampaignStatusRows(db, [d.c.campaignId]))?.get(d.c.campaignId);
        if (after?.read_error === 'not_found' && after.instantly_account_id === recordedWs) {
          notFoundReadIn.set(d.c.campaignId, recordedWs);
        }
      }
      if (res.unavailable) {
        // Кэш или функция аренды недоступны — дальше читать нечем.
        report.notStarted = due.length - i - 1;
        break;
      }
    }
    if (notFoundTriedAt.size > 5_000) notFoundTriedAt.clear();
    if (notFoundReadIn.size > 5_000) notFoundReadIn.clear();
    return report;
  } catch (e) {
    opts.log('warn', `[eng-block-sweep] прогон упал: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`);
    return report;
  }
}

/**
 * Обёртка прогона для цикла воркера: не чаще периода, выключатель, не больше
 * одного прогона за раз, очередь держится не дольше
 * HE_ENG_BLOCK_SWEEP_BUDGET_MS (прогон, не уложившийся в срок, доходит фоном,
 * а следующий не начнётся, пока он не кончится). `maybeRun` НЕ БРОСАЕТ.
 */
export function createHeEngBlockSweepTicker(opts: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log: HeEngSweepLog;
  shouldStop?: () => boolean;
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  run?: typeof runHeEngBlockedSweep;
}): { maybeRun: () => Promise<void> } {
  let nextAtMs = 0;
  let inFlight: Promise<void> | null = null;
  const run = opts.run ?? runHeEngBlockedSweep;
  const budgetMs = opts.budgetMs ?? HE_ENG_BLOCK_SWEEP_BUDGET_MS;
  return {
    maybeRun: async () => {
      if (!heEngBlockSweepEnabled(opts.env)) return;
      const nowMs = Date.now();
      if (inFlight || nowMs < nextAtMs) return;
      nextAtMs = nowMs + heEngBlockSweepIntervalMs(opts.env);
      const startedMs = nowMs;
      const current: Promise<void> = run({
        portalDb: opts.portalDb,
        instantlyDb: opts.instantlyDb,
        log: opts.log,
        shouldStop: opts.shouldStop,
      })
        .then((r) => {
          if (r.switchReasserted || r.switchFailed || r.switchSkipped || r.attempted || r.noWorkspace || r.notStarted || r.launchesUnread) {
            opts.log(
              'info',
              `[eng-block-sweep] заблокированных ${r.blocked} (взято ${r.accounts}): отправка выключена снова ${r.switchReasserted}, `
                + `не удалось ${r.switchFailed}, разблокированы по ходу ${r.switchSkipped}; кампаний ${r.campaigns}, пора ${r.due}, читали ${r.attempted} `
                + `(прочитано ${r.refreshed}, на паузу ${r.paused}, сбой ${r.failed}), без воркспейса ${r.noWorkspace}, `
                + `не дошли ${r.notStarted}${r.launchesUnread ? ', запуски не прочитаны' : ''}; ${Date.now() - startedMs} мс`,
            );
          }
        })
        .catch((e: unknown) => {
          opts.log('warn', `[eng-block-sweep] прогон бросил: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = current;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const budget = new Promise<'budget'>((resolve) => {
        timer = setTimeout(() => resolve('budget'), budgetMs);
      });
      const outcome = await Promise.race([current.then(() => 'done' as const), budget]);
      if (timer) clearTimeout(timer);
      if (outcome === 'budget') {
        opts.log('warn', `[eng-block-sweep] прогон дольше ${budgetMs} мс — очередь не ждёт, он доходит фоном`);
      }
    },
  };
}
