/**
 * ENG: блокировка и разблокировка клиента английского кабинета сотрудником.
 * Решения владельца 12.10.2026: «если бан, то всё нужно останавливать и
 * блокировать»; разблокировка возвращает только вход — после неё ничего само
 * не отправляет, не платит и не стартует: клиент запускает сам («Launch»,
 * «Start sending», «Daily top-up»), отправку включает сотрудник («Включить
 * отправку» в карточке клиента). Зовёт только POST /api/admin/users/[id]/block
 * — его ветка для profiles.role = 'client' AND market = 'eng' (модуль грузится
 * динамически только в ней: RU-путь роута его не видит). Ничего здесь НЕ
 * БРОСАЕТ.
 *
 * ОСТАНОВКА АККАУНТА — общая у блокировки и разблокировки. Каждый шаг
 * пробуется, даже если прошлый не лёг, у каждого свой срок:
 *  a. Выключатель отправки → 'revoked' (setHeEngSendingAccess(false)). Старт,
 *     идущий в эту минуту, перечитывает его перед каждым POST /activate и
 *     ставит стартованное на паузу; запуск, «Start sending», автозапуск и
 *     ночной долив (и повторный старт завершённой основной кампании) отказывают.
 *  b. Пауза кампаний всех запусков аккаунта (pauseHeEngAccountSending, where
 *     'staff_block'). Свой срок от своего начала (pauseBudgetMs: кампания
 *     начинается, только если до него остаётся запас на неё), и шаги c–d идут
 *     ПАРАЛЛЕЛЬНО с ней — срок паузы ни с кем не делится. Жёсткий предел
 *     pauseCapMs: запуски, не давшие исхода к нему, считаются «пауза не
 *     подтверждена» (unreadLaunches), а не пройденными. Отказ общего
 *     ограничителя или рассыльщика (без повторов на 429) — failed или
 *     notAttempted, НИКОГДА не «на паузе»: на паузе только кампания, чей не
 *     отправляющий статус рассыльщик подтвердил (engCampaignSending.pauseOne).
 *     Завершённая кампания (3) тоже не отправляет и считается вставшей; снова
 *     её стартует только ночной долив, а его закрывают шаги a и c того же
 *     нажатия. Кампания, до которой кабинет не дотягивается (воркспейса нет,
 *     или в запасном её нет, — запущена не из кабинета), — `unreachable`: её
 *     ставит на паузу человек в Instantly (красная строка и алерт
 *     'campaigns_unreachable'); подтверждение остановки она не держит.
 *  c. Работа каждого us-проекта (engProjectStop, режим 'staff_block';
 *     проекты — параллельно, срок шага projectStepMs): автопилот и отметка
 *     отмены, автозапуск, «Daily top-up» (выключается всегда — тем же путём,
 *     что у клиента), задачи, базы, дочерние джобы конструктора и парсеров,
 *     исследование → 'draft'.
 *  d. Неотправленные письма клиенту закрыты (attempts = 3, как у повтора
 *     engClientMail): очередь повторов их больше не берёт.
 * Остановка ПОДТВЕРЖДЕНА (heEngAccountStopConfirmed) — только когда: отправка
 * выключена (или уже была); список проектов прочитан, и у каждого проекта
 * легли все записи, а «Daily top-up» выключен (или уже был, или таблицы добора
 * нет); очередь писем закрыта; у паузы failed = 0, notAttempted = 0,
 * unreadLaunches = 0 и запуски прочитаны (недоступные кабинету кампании —
 * `unreachable` — в правило не входят: решение S3b, их ставит человек).
 *
 * БЛОКИРОВКА (blockHeEngAccount):
 *  0. Чтения «до» (срок stepMs у каждого): выключатель отправки
 *     (readHeEngSendingAccess → sending_before) параллельно со списком
 *     us-проектов аккаунта, затем «Daily top-up» этих проектов
 *     (he_auto_pipeline_configs.enabled → refill_enabled_before: 'on' / 'off' /
 *     'no_config'; сбой чтения — 'unknown' у каждого проекта; список проектов
 *     не прочитан — null).
 *  1. Отметка блокировки (markHeEngAccountBlocked) — ПЕРВОЙ записью: воркер,
 *     письма клиенту, автозапуск, гейт платных шагов и ночной добор видят
 *     блокировку сразу, даже если дальше что-то не ляжет. Повтор нажатия —
 *     'repeat': состояния «до» остаются от первого нажатия эпизода.
 *  2. Остановка a–d; вход — бан 876000h (как у RU-блокировки), затем отзыв
 *     сессий (RPC admin_revoke_user_sessions), и при неудачном бане — идёт
 *     параллельно с паузой, перед проектами.
 *  3. Отчёт → he_eng_account_blocks.last_stop (только своего нажатия: более
 *     позднее нажатие не затирается); аудит 'admin.users.block.eng_stop' — с
 *     состояниями «до» этого нажатия (в журнале они есть и тогда, когда
 *     отметка не записалась); не всё легло — алерт команде 'block_incomplete'
 *     (окно — 10 минут на аккаунт); недоступные кабинету кампании — алерт
 *     'campaigns_unreachable'. Повтор в эпизоде, который открыла
 *     «Разблокировать», несёт в отчёте opened_by 'unblock'.
 * «Всё остановлено» (`complete`) — остановка подтверждена, отметка записана,
 * бан и отзыв сессий легли, недоступных кабинету кампаний нет.
 *
 * ПОВТОРНОЕ НАЖАТИЕ («Заблокировать ещё раз / доставить остановку») — та же
 * функция: отметка — 'repeat', выключатель — «уже выключена», бан и отзыв
 * сессий — снова, остановка трогает только живое, письма — только
 * неотправленные, пауза — снова по всем запускам. Аккаунт, у которого бан
 * стоит, а отметки нет (заблокирован до этого раздела или мимо него), получает
 * этим нажатием полную остановку: отметка — 'new', состояния «до» читаются
 * сейчас.
 *
 * НЕ ОСТАНАВЛИВАЕТСЯ (строка-пояснение в отчёте): кампании, которые сотрудник
 * запустит руками у рассыльщика (их снова ставит на паузу чтение статуса —
 * engCampaignStatus, не сразу); письмо, уже отданное SMTP-серверу. Ящики пула
 * остаются за клиентом, пока сотрудник не освободит их руками.
 *
 * РАЗБЛОКИРОВКА (unblockHeEngAccount). Сначала — заблокирован ли клиент
 * (активная отметка или бан в GoTrue): нет — ничего не делается (кнопку нажали
 * в устаревшей карточке), не прочиталось — тоже. Пока бан стоит, клиент
 * ничего не нажмёт, поэтому ДО снятия бана остановка a–d повторяется целиком
 * (что уже выключено, даёт «уже»). Активной отметки нет (бан поставлен мимо
 * раздела, или при «Заблокировать» отметка не записалась) — перед остановкой
 * шаги 0–1 блокировки (чтения «до» и отметка с opened_by 'unblock': карточка
 * не выдаёт этот эпизод за блокировку), то есть та же полная остановка, что у
 * «Заблокировать». Нажатия копят паузу: кампания, чей не отправляющий статус
 * прочитан у рассыльщика после last_block_at эпизода и не раньше
 * HE_ENG_BLOCK_SWEEP_RECHECK_MS назад (столько фоновая проверка ждёт перед
 * перечитыванием такой кампании), второй раз на паузу не ставится и
 * засчитывается; через ограничитель идут только остальные. Недоступные
 * кабинету кампании подтверждение не держат. Не подтверждена — бан остаётся,
 * больше ничего не снимается: отчёт называет, что не остановилось, и
 * «Разблокировать ещё раз»; алерт команде 'unblock_incomplete'. Подтверждена
 * — отметка перечитывается: её last_block_at уже не тот, что у эпизода
 * (пока шла разблокировка, нажали «Заблокировать»), или она не перечиталась —
 * бан остаётся. Иначе бан 'none', и только если он снят — отметка снимается
 * условной записью по эпизоду (markHeEngAccountUnblocked; пока вход закрыт,
 * фоновые пути должны видеть блокировку). Отметку, которую сдвинуло
 * «Заблокировать» между перечитыванием и этой записью, она не снимает
 * ('superseded'), а бан ставится снова. Блокировка пишет отметку раньше бана,
 * разблокировка снимает бан раньше отметки — поэтому «Заблокировать», нажатое
 * по ходу разблокировки, остаётся в силе: его отметка легла либо до условной
 * записи (бан ставится снова), либо после неё (тогда и его бан — после снятия
 * бана здесь). После снятия бана выключатель отправки 'revoked', автопилот,
 * автозапуск и «Daily top-up» выключены, кампании на паузе — снова их
 * запускает только клиент, а отправку — сотрудник. Отчёт называет эти шаги,
 * состояния «до» из отметки и кто снова запустит исследование не
 * исследованных проектов (readHeEngAccountResearch).
 *
 * СКОЛЬКО НАЖАТИЙ «Разблокировать ещё раз». Пауза разблокировки начинает
 * кампании первые pauseBudgetMs − campaignReserveMs = 19 с. Кампанию, чью
 * паузу рассыльщик подтвердил (в этом нажатии или после его срока — статус всё
 * равно записывается), следующие нажатия в пределах 30 минут не трогают.
 * Нажатие, в котором рассыльщик подтвердил хоть одну паузу, двигает дело
 * вперёд, и аккаунту с C доступными кабинету кампаниями хватает ⌈C / k⌉ + 1
 * нажатий в пределах 30 минут, где k ≥ 1 — сколько пауз рассыльщик
 * подтверждает за нажатие: при полном ведре общего ограничителя (12 токенов,
 * 12 в минуту) — около 12–15, без ограничителя при ответе за 0,5 с — около
 * 38. Недоступная кабинету кампания, которую запасной воркспейс ответил
 * «404», стоит вызовов только в первом нажатии процесса, дошедшем до неё
 * (дальше её называют без вызова, engCampaignSending), — к счёту добавляется не
 * больше нажатий, чем таких кампаний. Фоновая проверка заблокированных
 * засчитывает ещё до 10 кампаний за прогон (раз в 5 минут) и без нажатий.
 * Нажатие, в котором рассыльщик отказал каждому вызову (429), не продвигает —
 * подождать минуту.
 *
 * СРОКИ при значениях по умолчанию (каждый шаг упёрся в свой срок):
 *  - блокировка (HE_ENG_BLOCK_TIMING): чтения «до» 6 с + отметка 3 с +
 *    выключатель 3 с = 12 с; дальше параллельно пауза ≤ pauseCapMs (42 с) и
 *    вход 5 + 3 с, проекты 7 × 3 = 21 с, письма 3 с (32 с); отчёт 3 с — итого
 *    ≤ 57 с;
 *  - разблокировка (HE_ENG_UNBLOCK_TIMING): бан, строка отметки и проекты 5 с
 *    (параллельно); без отметки ещё чтения «до» 3 с и отметка 3 с;
 *    выключатель 3 с; пауза ≤ 26 с параллельно с проектами и письмами (24 с);
 *    перечитывание отметки 3 с, снятие бана 5 с, снятие отметки 3 с и при
 *    'superseded' бан снова 5 с — с ними параллельно чтение исследования
 *    (6 с) — итого ≤ 56 с.
 * Роут держит maxDuration 60. Запись, пришедшая после срока шага, всё равно
 * ложится, а шаг в отчёте — неудавшийся: у остановки повтор ничего не портит,
 * а поздно снятый бан или отметку довершает повторное «Разблокировать».
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit, logWarn } from '@/lib/loggerServer';
import {
  HE_ENG_ACCOUNT_BLOCKS_MIGRATION,
  heEngSendingBeforeOf,
  markHeEngAccountBlocked,
  markHeEngAccountUnblocked,
  readHeEngAccountBlockRows,
  writeHeEngAccountBlockReport,
  type HeEngAccountBlockMark,
  type HeEngAccountBlockReportWrite,
  type HeEngAccountBlockRowsRead,
  type HeEngAccountStopReport,
  type HeEngAccountUnblockMark,
  type HeEngBlockCampaignsReport,
  type HeEngBlockLine,
  type HeEngBlockProjectReport,
  type HeEngBlockReport,
  type HeEngRefillBeforeMap,
  type HeEngResearchRestart,
  type HeEngSendingBefore,
  type HeEngUnblockReport,
  type HeEngUnreachableCampaign,
} from './engAccountBlockMarker';
import { toClientEngStageErrorCode } from './clientEngProjection';
import { HE_ENG_BLOCK_SWEEP_RECHECK_MS } from './engBlockedSweep';
import {
  pauseHeEngAccountSending,
  type HeEngAccountPauseCounts,
  type HeEngAccountPauseProgress,
} from './engCampaignSending';
import { HE_ENG_CLIENT_EMAILS_TABLE } from './engClientMail';
import { heEngBlockProjectReportOf, stopHeEngProjectWork } from './engProjectStop';
import { readHeEngSendingAccess, setHeEngSendingAccess, type HeEngSendingAccess } from './engSendingAccess';
import { notifyHeEngSending } from './engSendingAlert';
import { isHeMissingColumnError } from './projectCancelMarker';
import { engResearchRetryVerdict, HE_RESEARCH_STALL_GRACE_MS, readLatestHeResearchJob } from './researchJob';
import { normalizeWebsiteInput } from './websiteUrl';

/** Бан входа — тот же срок, что у RU-блокировки (100 лет). */
export const HE_ENG_BLOCK_BAN_DURATION = '876000h';

/** Попыток письма клиенту всего (engClientMail MAX_ATTEMPTS): строка с ними повтор не берёт. */
const CLIENT_EMAIL_MAX_ATTEMPTS = 3;

/** Сроки шагов (мс). Роут берёт значения по умолчанию. */
export interface HeEngBlockTiming {
  /** Одна запись или чтение БД (отметка, выключатель, письма, отчёт, чтения «до»). */
  stepMs: number;
  /** Вызов GoTrue (бан, снятие бана, чтение бана). */
  authMs: number;
  /** Шаг остановки одного проекта (engProjectStop stepTimeoutMs). */
  projectStepMs: number;
  /** Срок паузы кампаний от её начала (deadlineMs pauseHeEngAccountSending). */
  pauseBudgetMs: number;
  /** Жёсткий предел ожидания паузы от её начала. */
  pauseCapMs: number;
  /** Запас на кампанию до pauseBudgetMs (нет — engCampaignSending PER_CAMPAIGN_BUDGET_MS, 20 с). */
  campaignReserveMs?: number;
}

export const HE_ENG_BLOCK_TIMING: HeEngBlockTiming = {
  stepMs: 3_000,
  authMs: 5_000,
  projectStepMs: 3_000,
  pauseBudgetMs: 40_000,
  pauseCapMs: 42_000,
};

/**
 * Разблокировка: после остановки ещё перечитывание отметки, снятие бана и
 * отметки (и бан снова) — пауза короче, а запас на кампанию меньше: паузу,
 * подтверждённую после срока, засчитает следующее нажатие (сроки — шапка).
 */
export const HE_ENG_UNBLOCK_TIMING: HeEngBlockTiming = {
  ...HE_ENG_BLOCK_TIMING,
  pauseBudgetMs: 24_000,
  pauseCapMs: 26_000,
  campaignReserveMs: 5_000,
};

/* ─────────────── Служебное ─────────────── */

const TIMED_OUT: unique symbol = Symbol('timed_out');

/** Срок без обрыва: работа живёт дальше и может лечь позже — шаг считается неудавшимся. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms));
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Шаг со сроком: брошенное и срок — `fallback` (с записью в журнал). */
async function step<T>(name: string, ms: number, fallback: T, work: () => Promise<T>, ctx: Record<string, unknown>): Promise<T> {
  try {
    const res = await withTimeout(work(), ms);
    if (res === TIMED_OUT) {
      void logWarn(`he.eng_block.${name}_timeout`, `step ${name} exceeded ${ms} ms`, ctx);
      return fallback;
    }
    return res;
  } catch (e) {
    void logWarn(`he.eng_block.${name}_threw`, e instanceof Error ? e.message.slice(0, 300) : 'unknown', ctx);
    return fallback;
  }
}

function pgText(prefix: string, error: { code?: string | null; message?: string | null } | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

function isTableMissing(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42P01' || code === 'PGRST205';
}

function websiteLabel(raw: unknown): string | null {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return null;
  return normalizeWebsiteInput(url)?.hostname ?? url.slice(0, 120);
}

interface AccountProject {
  id: string;
  website: string | null;
}

type ProjectsRead = { kind: 'ok'; projects: AccountProject[] } | { kind: 'failed' };

/** us-проекты аккаунта (те же, что у паузы и выключателя: created_by + market 'us'). */
async function readAccountProjects(db: SupabaseClient, userId: string): Promise<ProjectsRead> {
  const { data, error } = await db
    .from('he_projects')
    .select('id, website_url')
    .eq('created_by', userId)
    .eq('market', 'us');
  if (error) {
    void logWarn('he.eng_block.projects_read_failed', pgText('he_projects read', error), { userId });
    return { kind: 'failed' };
  }
  const projects: AccountProject[] = [];
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id) projects.push({ id, website: websiteLabel(raw.website_url) });
  }
  return { kind: 'ok', projects };
}

/** «Daily top-up» проектов до остановки (refill_enabled_before). */
async function readRefillBefore(db: SupabaseClient, projectIds: string[]): Promise<HeEngRefillBeforeMap> {
  const out: HeEngRefillBeforeMap = {};
  if (projectIds.length === 0) return out;
  const unknown = (): HeEngRefillBeforeMap => Object.fromEntries(projectIds.map((id) => [id, 'unknown' as const]));
  const { data, error } = await db
    .from('he_auto_pipeline_configs')
    .select('project_id, enabled')
    .in('project_id', projectIds);
  if (error) {
    // Таблицы добора нет — добора нет ни у одного проекта.
    if (isTableMissing(error)) return Object.fromEntries(projectIds.map((id) => [id, 'no_config' as const]));
    void logWarn('he.eng_block.refill_read_failed', pgText('he_auto_pipeline_configs read', error), {});
    return unknown();
  }
  const enabled = new Map<string, boolean>();
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    if (typeof raw.project_id === 'string') enabled.set(raw.project_id, raw.enabled === true);
  }
  for (const id of projectIds) {
    const on = enabled.get(id);
    out[id] = on === undefined ? 'no_config' : on ? 'on' : 'off';
  }
  return out;
}

/** Закрыть неотправленные письма клиенту. Таблицы нет — писем в очереди нет (0). */
async function closeQueuedClientEmails(db: SupabaseClient, userId: string, now: Date): Promise<number | 'failed'> {
  const { data, error } = await db
    .from(HE_ENG_CLIENT_EMAILS_TABLE)
    .update({ attempts: CLIENT_EMAIL_MAX_ATTEMPTS, last_attempt_at: now.toISOString() })
    .eq('user_id', userId)
    .is('sent_at', null)
    .lt('attempts', CLIENT_EMAIL_MAX_ATTEMPTS)
    .select('dedupe_key');
  if (error) {
    if (isTableMissing(error)) return 0;
    void logWarn('he.eng_block.client_emails_failed', pgText('he_eng_client_emails close', error), { userId });
    return 'failed';
  }
  return (data ?? []).length;
}

/* ─────────────── Шаги (общие у блокировки и разблокировки) ─────────────── */

type Ctx = Record<string, unknown>;

interface StepEnv {
  portalDb: SupabaseClient;
  userId: string;
  staffUserId: string | null;
  now: Date;
  timing: HeEngBlockTiming;
  ctx: Ctx;
}

function readProjectsStep(env: StepEnv): Promise<ProjectsRead> {
  return step<ProjectsRead>('projects_read', env.timing.stepMs, { kind: 'failed' }, () =>
    readAccountProjects(env.portalDb, env.userId), env.ctx);
}

/** Шаг 0: выключатель отправки и «Daily top-up» до остановки (список проектов уже прочитан или читается). */
async function readStateBefore(
  env: StepEnv,
  projectsRead: Promise<ProjectsRead>,
): Promise<{ access: HeEngSendingAccess | null; sendingBefore: HeEngSendingBefore; refillBefore: HeEngRefillBeforeMap | null }> {
  const accessP = step<HeEngSendingAccess | null>('sending_read', env.timing.stepMs, null, () =>
    readHeEngSendingAccess(env.portalDb, env.userId, { skipEnv: true }), env.ctx);
  const projects = await projectsRead;
  const refillBefore: HeEngRefillBeforeMap | null =
    projects.kind === 'ok'
      ? await step<HeEngRefillBeforeMap>(
          'refill_read',
          env.timing.stepMs,
          Object.fromEntries(projects.projects.map((p) => [p.id, 'unknown' as const])),
          () => readRefillBefore(env.portalDb, projects.projects.map((p) => p.id)),
          env.ctx,
        )
      : null;
  const access = await accessP;
  return { access, sendingBefore: access ? heEngSendingBeforeOf(access) : 'unknown', refillBefore };
}

/**
 * Шаг 1: отметка блокировки ('ok' — записана новой или повтором). `openedBy`
 * 'unblock' — её пишет «Разблокировать» у бана без отметки.
 */
async function markStep(
  env: StepEnv,
  before: { sendingBefore: HeEngSendingBefore; refillBefore: HeEngRefillBeforeMap | null },
  openedBy?: 'unblock',
): Promise<{ state: 'ok' | 'missing' | 'failed'; mark: HeEngAccountBlockMark }> {
  const mark = await step<HeEngAccountBlockMark>(
    'marker',
    env.timing.stepMs,
    { state: 'error', detail: 'timeout or throw', code: null },
    () =>
      markHeEngAccountBlocked(env.portalDb, {
        userId: env.userId,
        staffUserId: env.staffUserId,
        now: env.now,
        sendingBefore: before.sendingBefore,
        refillEnabledBefore: before.refillBefore,
        openedBy,
      }),
    env.ctx,
  );
  if (mark.state === 'error') void logWarn('he.eng_block.marker_failed', mark.detail, env.ctx);
  return {
    state: mark.state === 'new' || mark.state === 'repeat' ? 'ok' : mark.state === 'missing' ? 'missing' : 'failed',
    mark,
  };
}

/** Шаг a: выключатель отправки; `email` — адрес профиля из строки выключателя (для алерта). */
async function revokeSendingStep(env: StepEnv): Promise<{ outcome: HeEngBlockReport['sending_switch']; email: string | null }> {
  return step('sending_switch', env.timing.stepMs, { outcome: 'failed' as const, email: null }, async () => {
    const set = await setHeEngSendingAccess(env.portalDb, env.userId, false);
    if (set.kind !== 'updated') {
      void logWarn('he.eng_block.sending_switch_failed', set.kind === 'error' ? set.message : set.kind, env.ctx);
      return { outcome: 'failed' as const, email: null };
    }
    return { outcome: set.changed ? ('revoked' as const) : ('already' as const), email: set.row.email };
  }, env.ctx);
}

/** Счётчики паузы 'staff_block' → отчёт (у 'staff_block' оба поля есть всегда). */
function campaignsReportOf(c: HeEngAccountPauseCounts): HeEngBlockCampaignsReport {
  return {
    launches: c.launches,
    paused: c.paused,
    failed: c.failed,
    notAttempted: c.notAttempted,
    unreadLaunches: c.unreadLaunches,
    readFailed: c.readFailed,
    confirmedEarlier: c.confirmedEarlier ?? 0,
    unreachable: [...(c.unreachable ?? [])],
  };
}

/**
 * Шаг b: пауза кампаний — свой срок от своего начала (шапка модуля). БД
 * рассыльщика нет — запуски не прочитаны. `confirmedSinceMs` — только
 * разблокировка: кампании, чья пауза прочитана с этого момента, засчитываются
 * без вызова.
 */
async function pauseCampaignsStep(
  env: StepEnv,
  instantlyDb: SupabaseClient | null,
  confirmedSinceMs?: number,
): Promise<HeEngBlockCampaignsReport> {
  const counts: HeEngAccountPauseCounts = {
    launches: 0,
    paused: 0,
    failed: 0,
    notAttempted: 0,
    unreadLaunches: 0,
    readFailed: false,
    confirmedEarlier: 0,
    unreachable: [],
  };
  if (!instantlyDb) return campaignsReportOf({ ...counts, readFailed: true });
  const start = Date.now();
  const progress: HeEngAccountPauseProgress = { counts, listed: false, settledLaunches: 0 };
  let outcome: HeEngAccountPauseCounts | typeof TIMED_OUT;
  try {
    outcome = await withTimeout(
      pauseHeEngAccountSending({
        portalDb: env.portalDb,
        instantlyDb,
        userId: env.userId,
        deadlineMs: start + env.timing.pauseBudgetMs,
        where: 'staff_block',
        progress,
        confirmedSinceMs,
        campaignReserveMs: env.timing.campaignReserveMs,
      }),
      env.timing.pauseCapMs,
    );
  } catch (e) {
    void logWarn('he.eng_block.pause_threw', e instanceof Error ? e.message.slice(0, 300) : 'unknown', env.ctx);
    outcome = TIMED_OUT;
  }
  if (outcome !== TIMED_OUT) return campaignsReportOf(outcome);
  // Предел паузы: что успело — в счёт; запуски без исхода — «пауза не
  // подтверждена»; запуски не прочитаны к пределу — «не прочитались».
  const c = campaignsReportOf(progress.counts);
  void logWarn('he.eng_block.pause_cap', `campaign pause did not finish within ${env.timing.pauseCapMs} ms`, {
    ...env.ctx,
    listed: progress.listed,
    launches: c.launches,
    settled: progress.settledLaunches,
  });
  return progress.listed
    ? { ...c, unreadLaunches: c.unreadLaunches + Math.max(0, c.launches - progress.settledLaunches) }
    : { ...c, readFailed: true };
}

/** Шаг c: работа каждого us-проекта (параллельно). Список не прочитан — пусто (отчёт: projects_read 'failed'). */
async function stopProjectsStep(env: StepEnv, projectsRead: ProjectsRead): Promise<HeEngBlockProjectReport[]> {
  if (projectsRead.kind !== 'ok') return [];
  return Promise.all(
    projectsRead.projects.map(async (p) =>
      heEngBlockProjectReportOf(
        await stopHeEngProjectWork(env.portalDb, p.id, {
          by: 'staff_block',
          now: env.now,
          userId: env.userId,
          staffUserId: env.staffUserId,
          stepTimeoutMs: env.timing.projectStepMs,
        }),
        p.website,
        p.id,
      ),
    ),
  );
}

/** Шаг d: очередь писем клиенту. */
function closeEmailsStep(env: StepEnv): Promise<number | 'failed'> {
  return step<number | 'failed'>('client_emails', env.timing.stepMs, 'failed', () =>
    closeQueuedClientEmails(env.portalDb, env.userId, env.now), env.ctx);
}

/* ─────────────── Правило «остановка подтверждена» ─────────────── */

const TOP_UP_STOPPED: ReadonlyArray<HeEngBlockProjectReport['top_up']> = ['turned_off', 'already_off', 'unsupported'];

function projectStopped(p: HeEngBlockProjectReport): boolean {
  return p.ok && TOP_UP_STOPPED.includes(p.top_up);
}

/** Пауза подтверждена. Недоступные кабинету кампании (`unreachable`) её не держат — у них своя строка и алерт. */
function campaignsStopped(c: HeEngBlockCampaignsReport): boolean {
  return !c.readFailed && c.failed === 0 && c.notAttempted === 0 && c.unreadLaunches === 0;
}

/** Остановка a–d подтверждена (правило — в шапке модуля). */
export function heEngAccountStopConfirmed(r: HeEngAccountStopReport): boolean {
  return (
    (r.sending_switch === 'revoked' || r.sending_switch === 'already')
    && r.projects_read === 'ok'
    && r.projects.every(projectStopped)
    && typeof r.client_emails === 'number'
    && campaignsStopped(r.campaigns)
  );
}

/**
 * Блокировка довершена: остановка подтверждена, отметка записана, бан и отзыв
 * сессий легли, и недоступных кабинету кампаний нет (их ставит человек).
 */
function heEngBlockComplete(r: Omit<HeEngBlockReport, 'complete'>): boolean {
  return (
    r.marker === 'ok'
    && r.ban === 'ok'
    && r.sessions === 'ok'
    && heEngAccountStopConfirmed(r)
    && r.campaigns.unreachable.length === 0
  );
}

/* ─────────────── Строки для сотрудника ─────────────── */

/** Кнопка, которая повторяет остановку: у блокировки и у разблокировки. */
const AGAIN_BLOCK = '«Заблокировать ещё раз»';
const AGAIN_UNBLOCK = '«Разблокировать ещё раз»';

function siteOf(p: Pick<HeEngBlockProjectReport, 'website' | 'project_id'>): string {
  return p.website ?? p.project_id;
}

/**
 * Записи проекта, которые не легли (кроме «Daily top-up» — у него своя строка).
 * `ok` проекта ложен ещё и при неудачном «Daily top-up»; иная причина без
 * названного шага — «часть записей».
 */
function projectFailedParts(p: HeEngBlockProjectReport): string[] {
  const parts: string[] = [];
  if (p.autopilot === 'failed') parts.push('автопилот');
  if (p.intent === 'failed') parts.push('автозапуск');
  if (p.jobs === 'failed') parts.push('задачи');
  if (p.bases === 'failed') parts.push('базы');
  if (p.children === 'failed') parts.push('джобы конструктора и парсеров');
  if (p.research === 'failed') parts.push('исследование');
  if (parts.length === 0 && !p.ok && p.top_up !== 'failed') parts.push('часть записей');
  return parts;
}

function projectLines(p: HeEngBlockProjectReport, again: string): HeEngBlockLine[] {
  const site = siteOf(p);
  const lines: HeEngBlockLine[] = [];
  const failed = projectFailedParts(p);
  if (failed.length > 0) {
    lines.push({
      tone: 'red',
      text: `Проект ${site}: остановить работу не удалось (${failed.join(', ')}) — нажмите ${again}`,
    });
  } else {
    const n = (v: number | 'failed') => (typeof v === 'number' ? v : 0);
    lines.push({
      tone: 'ok',
      text:
        `Проект ${site}: автозапуск выключен; остановлено задач: ${n(p.jobs)}, баз: ${n(p.bases)}, ` +
        `джоб конструктора и парсеров: ${n(p.children)}`,
    });
  }
  switch (p.top_up) {
    case 'turned_off':
      lines.push({ tone: 'ok', text: `Проект ${site}: ночной добор («Daily top-up») выключен` });
      break;
    case 'already_off':
      lines.push({ tone: 'ok', text: `Проект ${site}: ночной добор («Daily top-up») уже был выключен` });
      break;
    case 'unsupported':
      lines.push({ tone: 'note', text: `Проект ${site}: таблицы ночного добора нет — добора нет` });
      break;
    case 'failed':
      lines.push({
        tone: 'red',
        text: `Проект ${site}: ночной добор («Daily top-up») выключить не удалось — нажмите ${again}`,
      });
      break;
  }
  if (p.research === 'stopped') {
    lines.push({ tone: 'note', text: `Проект ${site}: исследование было в работе — оно остановлено` });
  }
  return lines;
}

function switchLine(s: HeEngBlockReport['sending_switch']): HeEngBlockLine {
  switch (s) {
    case 'revoked':
      return { tone: 'ok', text: 'Отправка выключена' };
    case 'already':
      return { tone: 'ok', text: 'Отправка уже была выключена' };
    case 'failed':
      return { tone: 'red', text: 'Отправку выключить не удалось' };
  }
}

function projectsLines(r: HeEngAccountStopReport, again: string): HeEngBlockLine[] {
  if (r.projects_read === 'failed') {
    return [{ tone: 'red', text: `Проекты клиента не прочитались — их работа не остановлена; нажмите ${again}` }];
  }
  if (r.projects.length === 0) return [{ tone: 'note', text: 'Проектов у клиента нет — останавливать нечего' }];
  return r.projects.flatMap((p) => projectLines(p, again));
}

function emailsLine(r: HeEngAccountStopReport): HeEngBlockLine {
  return typeof r.client_emails === 'number'
    ? { tone: 'ok', text: `Письма клиенту остановлены (снято из очереди: ${r.client_emails})` }
    : { tone: 'red', text: 'Очередь писем клиенту не очищена' };
}

/** Недоступная кабинету кампания — одной строкой для сотрудника: что искать в Instantly и где. */
function heEngUnreachableText(c: HeEngUnreachableCampaign): string {
  const where = [
    c.workspace ? `воркспейс ${c.workspace}` : null,
    c.not_found_in ? `в воркспейсе ${c.not_found_in} её нет` : null,
  ].filter((v): v is string => v !== null);
  return `${c.name ? `«${c.name}» (${c.campaign_id})` : c.campaign_id}, ${where.length > 0 ? where.join(', ') : 'воркспейс неизвестен'}`;
}

function campaignLines(c: HeEngBlockCampaignsReport, again: string, mode: 'block' | 'unblock'): HeEngBlockLine[] {
  if (c.readFailed) {
    return [
      {
        tone: 'red',
        text:
          mode === 'unblock'
            ? `Запуски клиента не прочитались — кампании на паузу не ставились, блокировка не снята. Нажмите ${again}: ` +
              'пока запуски не прочитаются, пауза руками у рассыльщика снять блокировку не поможет'
            : `Запуски клиента не прочитались — кампании на паузу не ставились. Нажмите ${again} или поставьте их на ` +
              'паузу у рассыльщика руками',
      },
    ];
  }
  if (c.launches === 0) return [{ tone: 'ok', text: 'Кампаний нет — ставить на паузу нечего' }];
  const known = c.paused + c.failed + c.notAttempted + c.unreachable.length;
  const lines: HeEngBlockLine[] = [];
  const holding = !campaignsStopped(c);
  lines.push({
    tone: holding || c.unreachable.length > 0 ? 'red' : 'ok',
    text:
      `Кампании на паузе: ${c.paused} из ${known}` +
      (c.confirmedEarlier > 0
        ? ` (из них ${c.confirmedEarlier} — по статусу, прочитанному у рассыльщика уже во время этой блокировки; повторно не трогали)`
        : ''),
  });
  if (holding) {
    lines.push({
      tone: 'red',
      text:
        `Не встали на паузу: ${c.failed}; не успели: ${c.notAttempted}; запусков, по которым пауза не ` +
        `подтвердилась: ${c.unreadLaunches} — ` +
        (mode === 'unblock'
          ? `нажмите ${again}: вставшие на паузу уже засчитаны, повтор продолжит с остальных`
          : `нажмите ${again} или поставьте их на паузу у рассыльщика руками`),
    });
  }
  if (c.unreachable.length > 0) {
    lines.push({
      tone: 'red',
      text:
        `Кабинет не может поставить на паузу кампании (${c.unreachable.length}) — они запущены не из кабинета, или ` +
        `их воркспейс неизвестен.${mode === 'unblock' ? ' Снятие блокировки они не держат.' : ''} Поставьте на паузу руками в ` +
        `Instantly: ${c.unreachable.map(heEngUnreachableText).join('; ')}`,
    });
  }
  return lines;
}

/** Остановка a–d — строки в порядке шагов (выключатель, проекты, письма, кампании). */
function stopLines(r: HeEngAccountStopReport, again: string, mode: 'block' | 'unblock'): HeEngBlockLine[] {
  return [
    switchLine(r.sending_switch),
    ...projectsLines(r, again),
    emailsLine(r),
    ...campaignLines(r.campaigns, again, mode),
  ];
}

// Без отметки блокировку видят только проверки, которые читают и бан
// (readHeEngOwnerHold / readHeEngAccountStanding и письма клиенту); отметку
// одну читают страж взятия задач воркера и фоновая проверка заблокированных
// (engBlockedSweep).
const SEEN_BY_BAN =
  'блокировку видят только проверки бана (новые платные шаги, следующие шаги автопилота, автозапуск, ночной ' +
  'добор, письма клиенту); уже поставленные задачи и фоновая проверка заблокированных её не видят';
const SEEN_BY_NONE =
  'блокировку не видит ни одна проверка — держат только записи самой остановки (выключатель отправки, ' +
  'автопилот, автозапуск, «Daily top-up», пауза кампаний), если они легли';

/**
 * Строки отчёта блокировки (карточка клиента, ответ роута) — по одному
 * отчёту, без чтений: первая строка — итог. Красная — то, что не остановилось.
 */
export function heEngBlockReportLines(r: HeEngBlockReport): HeEngBlockLine[] {
  const lines: HeEngBlockLine[] = [];
  if (r.complete) {
    lines.push({ tone: 'ok', text: 'Клиент заблокирован, всё остановлено.' });
  } else if (r.ban !== 'ok') {
    lines.push({
      tone: 'red',
      text:
        'Вход клиента не закрыт — блокировка не довершена. Нажмите «Заблокировать ещё раз»: остановка повторится ' +
        'там, где не дошла.',
    });
  } else if (heEngBlockFailedSteps(r).length > 0) {
    lines.push({
      tone: 'red',
      text:
        'Клиент заблокирован не полностью — часть работы не остановилась. Нажмите «Заблокировать ещё раз»: ' +
        'остановка повторится там, где не дошла.',
    });
  } else {
    // Не подтверждено только то, до чего кабинет не дотягивается: повтор не поможет.
    lines.push({
      tone: 'red',
      text:
        'Клиент заблокирован, всё, до чего дотягивается кабинет, остановлено. Кампании, которые кабинет на паузу ' +
        'поставить не может, поставьте руками в Instantly (список ниже).',
    });
  }

  switch (r.marker) {
    case 'ok':
      lines.push({ tone: 'ok', text: 'Отметка блокировки записана' });
      break;
    case 'missing':
      lines.push({
        tone: 'red',
        text:
          `Таблица блокировок не создана — примените миграцию ${HE_ENG_ACCOUNT_BLOCKS_MIGRATION}. ` +
          (r.ban === 'ok' ? `Пока её нет, ${SEEN_BY_BAN}` : `Бан тоже не поставился: ${SEEN_BY_NONE}`),
      });
      break;
    case 'failed':
      lines.push({
        tone: 'red',
        text:
          r.ban === 'ok'
            ? `Отметка блокировки не записалась — ${SEEN_BY_BAN}`
            : `Отметка блокировки не записалась, и бан не поставился — ${SEEN_BY_NONE}`,
      });
      break;
  }

  const [switchFirst, ...rest] = stopLines(r, AGAIN_BLOCK, 'block');
  lines.push(switchFirst);

  if (r.ban === 'ok' && r.sessions === 'ok') {
    lines.push({ tone: 'ok', text: 'Вход закрыт, сессии завершены' });
  } else if (r.ban === 'ok') {
    lines.push({ tone: 'red', text: 'Вход закрыт, но открытые сессии не завершены' });
  } else {
    lines.push({
      tone: 'red',
      text:
        r.sessions === 'ok'
          ? 'Вход не закрыт — бан не поставился (открытые сессии завершены)'
          : 'Вход не закрыт — бан не поставился, открытые сессии не завершены',
    });
  }

  lines.push(...rest);
  lines.push({
    tone: 'note',
    text:
      'Кампании, которые сотрудник запустит руками у рассыльщика, блокировка не держит — фоновое чтение статуса ' +
      'ставит их на паузу не сразу. Ящики отправки остаются за клиентом, пока их не освободят руками.',
  });
  return lines;
}

/** Что из остановки a–d не подтвердилось — коротко, для алерта и фразы ошибки. */
function stopFailedSteps(r: HeEngAccountStopReport): string[] {
  const out: string[] = [];
  if (r.sending_switch === 'failed') out.push('выключение отправки');
  if (r.projects_read === 'failed') out.push('проекты не прочитались');
  for (const p of r.projects) {
    const parts = projectFailedParts(p);
    if (!TOP_UP_STOPPED.includes(p.top_up)) parts.push('ночной добор');
    if (parts.length > 0) out.push(`проект ${siteOf(p)}: ${parts.join(', ')}`);
  }
  if (r.client_emails === 'failed') out.push('очередь писем клиенту');
  const c = r.campaigns;
  if (c.readFailed) out.push('пауза кампаний (запуски не прочитались)');
  else if (!campaignsStopped(c)) {
    out.push(
      `пауза кампаний (не встали: ${c.failed}, не успели: ${c.notAttempted}, без подтверждения запусков: ${c.unreadLaunches})`,
    );
  }
  return out;
}

/** Что не остановилось при блокировке — коротко, для алерта и фразы ошибки. Пусто — всё. */
function heEngBlockFailedSteps(r: Omit<HeEngBlockReport, 'complete'>): string[] {
  const out: string[] = [];
  if (r.marker === 'missing') out.push(`отметка блокировки (нет таблицы — миграция ${HE_ENG_ACCOUNT_BLOCKS_MIGRATION})`);
  if (r.marker === 'failed') out.push('отметка блокировки');
  if (r.ban !== 'ok') out.push('бан входа');
  if (r.sessions !== 'ok') out.push('отзыв сессий');
  return [...out, ...stopFailedSteps(r)];
}

const SENDING_BEFORE_TEXT: Record<HeEngSendingBefore, string> = {
  enabled: 'включена',
  waiting: 'ждала включения',
  not_enabled: 'не включена',
  revoked: 'уже выключена',
  not_required: 'не требовала включения',
  unknown: 'неизвестно (не прочиталось)',
};

/**
 * Что не снято, пока разблокировка не довершена, — по бану перед ней: стоял —
 * бан; не стоял (держит одна отметка) — отметка; не прочитался — блокировка.
 */
function notLiftedText(r: Pick<HeEngUnblockReport, 'ban_before'>): string {
  return r.ban_before === false ? 'Отметка блокировки не снята' : r.ban_before === null ? 'Блокировка не снята' : 'Бан не снят';
}

/** Бана нет, держит одна отметка: что клиент может и чего нет. */
const MARKER_ONLY =
  'бана нет — клиент может войти, но пока стоит отметка, платные шаги, запуск, отправку и ночной добор ему не включить';

/** Откуда остановка разблокировки и что с отметкой перед ней. */
function unblockOriginLines(r: HeEngUnblockReport): HeEngBlockLine[] {
  switch (r.marker_before) {
    case 'active':
      return [
        {
          tone: 'note',
          text:
            r.ban_before === false
              ? `Перед снятием отметки остановка блокировки повторена (${MARKER_ONLY}):`
              : r.ban_before === null
                ? 'Перед снятием блокировки остановка повторена (бан перед разблокировкой не прочитался):'
                : 'Перед снятием бана остановка блокировки повторена (пока бан стоит, клиент ничего не включит):',
        },
      ];
    case 'missing':
      return [
        {
          tone: 'note',
          text:
            `Таблицы блокировок нет (миграция ${HE_ENG_ACCOUNT_BLOCKS_MIGRATION} не применена) — перед снятием бана ` +
            'сделана та же полная остановка, что у «Заблокировать», без отметки:',
        },
      ];
    case 'unread':
      return [
        {
          tone: 'note',
          text: 'Отметка блокировки не прочиталась — перед снятием бана сделана полная остановка (отметку перед ней не писали):',
        },
      ];
    case 'none': {
      const head =
        'Отметки блокировки не было (бан поставлен мимо раздела, или при «Заблокировать» она не записалась) — перед ' +
        'снятием бана сделана та же полная остановка, что у «Заблокировать»';
      if (r.marker_written === 'ok') return [{ tone: 'note', text: `${head}, с отметкой:` }];
      if (r.marker_written === 'taken') {
        const who = r.opened_by === 'unblock' ? 'параллельное «Разблокировать»' : '«Заблокировать», нажатое по ходу';
        return [{ tone: 'note', text: `${head}; отметку тем временем завело ${who}:` }];
      }
      // Отметка не записалась: пока бан стоит (остановка не подтверждена или
      // бан не снялся), фоновые проверки отметки блокировку не видят.
      const held = r.ban !== 'lifted' ? ` Пока бан стоит, ${SEEN_BY_BAN}.` : '';
      return [
        {
          tone: r.ban !== 'lifted' ? 'red' : 'note',
          text:
            r.marker_written === 'missing'
              ? `${head}; таблицы блокировок нет (миграция ${HE_ENG_ACCOUNT_BLOCKS_MIGRATION}), отметку записать некуда.${held}`
              : `${head}; отметку записать не вышло.${held}`,
        },
      ];
    }
  }
}

function unblockMarkerLine(r: HeEngUnblockReport): HeEngBlockLine | null {
  switch (r.marker) {
    case 'cleared':
      return { tone: 'ok', text: 'Отметка блокировки снята' };
    case 'not_blocked':
      return { tone: 'note', text: 'Активной отметки блокировки не было — снимать нечего' };
    case 'missing':
      // Про таблицу уже сказала строка остановки.
      return r.marker_before === 'missing'
        ? null
        : { tone: 'note', text: `Таблицы блокировок нет (миграция ${HE_ENG_ACCOUNT_BLOCKS_MIGRATION} не применена) — снимать отметку негде` };
    case 'failed':
      return {
        tone: 'red',
        text:
          'Отметка блокировки не снята — фоновые проверки по-прежнему считают клиента заблокированным; нажмите ' +
          '«Разблокировать» ещё раз',
      };
    case 'superseded':
      // Итог уже сказала первая строка.
      return { tone: 'note', text: 'Отметка блокировки не снята: её сдвинуло «Заблокировать», нажатое по ходу разблокировки' };
    case 'skipped':
      return {
        tone: 'note',
        text:
          r.ban_before === false
            ? 'Отметка блокировки не тронута: пока разблокировка не довершена, фоновые проверки должны видеть блокировку'
            : 'Отметка блокировки не тронута: пока вход закрыт, фоновые проверки должны видеть блокировку',
      };
  }
}

/** Первая строка отчёта разблокировки: чем кончилось нажатие. */
function unblockHeadline(r: HeEngUnblockReport): HeEngBlockLine {
  const held = notLiftedText(r);
  if (r.ban === 'kept') {
    switch (r.kept_by) {
      case 'reblocked':
        return {
          tone: 'red',
          text: `${held}: пока шла разблокировка, нажали «Заблокировать» — клиент остаётся заблокированным.`,
        };
      case 'unverified':
        return {
          tone: 'red',
          text:
            `${held}: остановка подтверждена, но перед снятием не удалось убедиться, что за это время клиента не ` +
            'заблокировали снова (отметка блокировки не перечиталась или появилась, хотя у этого нажатия её не было). ' +
            'Нажмите «Разблокировать» ещё раз.',
        };
      default: {
        const lifts = r.ban_before === false ? 'отметка снимется' : r.ban_before === null ? 'блокировка снимется' : 'бан снимется';
        return {
          tone: 'red',
          text:
            `${held}: остановка перед разблокировкой подтвердилась не полностью. Нажмите ${AGAIN_UNBLOCK} — ` +
            `остановка повторится, и ${lifts}, когда подтвердится всё.`,
        };
      }
    }
  }
  if (r.ban === 'failed') {
    return {
      tone: 'red',
      text:
        r.ban_before === true
          ? 'Бан не снялся — вход по-прежнему закрыт. Нажмите «Разблокировать» ещё раз'
          : `${held}: запрос снятия бана не прошёл. Нажмите «Разблокировать» ещё раз`,
    };
  }
  if (r.marker === 'superseded') {
    return {
      tone: 'red',
      text:
        r.reban === 'ok'
          ? 'Пока шла разблокировка, нажали «Заблокировать» — бан поставлен снова, клиент остаётся заблокированным.'
          : 'Пока шла разблокировка, нажали «Заблокировать», а бан уже был снят и вернуть его не удалось: вход ' +
            'открыт, отметка блокировки стоит. Нажмите «Заблокировать ещё раз / доставить остановку».',
    };
  }
  return { tone: 'ok', text: 'Вход открыт' };
}

const RESEARCH_RESTART_TEXT: Record<HeEngResearchRestart, string> = {
  try_again: 'исследование не закончено — клиент может запустить его снова сам кнопкой «Try again» на шаге 1',
  team_fix:
    'исследование упало на нашей стороне (деньги или настройка провайдера) — после починки клиент запустит его снова ' +
    'кнопкой «Try again» на шаге 1',
  team:
    'исследование не закончено, и из кабинета его не запустить (кабинет повторяет его только после технического ' +
    'сбоя) — перезапустите в инструменте, если нужно',
  running: 'исследование идёт',
};

/**
 * Строки отчёта разблокировки — по одному отчёту, без чтений. Первая — итог
 * (unblockHeadline). Дальше — откуда остановка, её строки (у несработавших —
 * «Разблокировать ещё раз», у недоступных кабинету кампаний — «поставьте на
 * паузу руками в Instantly») и отметка; после снятия бана — что дальше делают
 * сотрудник и клиент, состояния «до» и исследование проектов.
 */
export function heEngUnblockReportLines(r: HeEngUnblockReport): HeEngBlockLine[] {
  const lines: HeEngBlockLine[] = [unblockHeadline(r)];
  lines.push(...unblockOriginLines(r), ...stopLines(r.stop, AGAIN_UNBLOCK, 'unblock'));
  const markerLine = unblockMarkerLine(r);
  if (markerLine) lines.push(markerLine);
  if (r.ban !== 'lifted' || r.marker === 'superseded') return lines;

  // Состояния «до»: из отметки эпизода (его открыла «Заблокировать» или прошлое
  // «Разблокировать») или прочитанные перед этой остановкой.
  const before =
    r.marker_before !== 'active'
      ? 'перед этой остановкой'
      : r.opened_by === 'unblock'
        ? 'перед остановкой прошлого «Разблокировать»'
        : 'до блокировки';
  const Before = before.charAt(0).toUpperCase() + before.slice(1);
  const sendingWas = r.sending_before ? ` ${Before} отправка была: ${SENDING_BEFORE_TEXT[r.sending_before]}.` : '';
  lines.push(
    r.marker === 'failed'
      ? {
          tone: 'red',
          text: `Сначала нажмите «Разблокировать» ещё раз — пока отметка блокировки стоит, «Включить отправку» откажет.${sendingWas}`,
        }
      : { tone: 'note', text: `Дальше: включите отправку кнопкой «Включить отправку», когда будете готовы.${sendingWas}` },
  );
  lines.push({
    tone: 'note',
    text:
      'Рынки сами не запустятся: клиент нажмёт «Launch» на шаге 3; кампании на паузе — «Start sending» у каждого ' +
      'рынка; ночной добор («Daily top-up») — «Turn on» на дашборде.',
  });

  const siteById = new Map(r.stop.projects.map((p) => [p.project_id, siteOf(p)]));
  const refill = r.refill_enabled_before;
  if (refill === null) {
    if (r.marker_before === 'active') lines.push({ tone: 'note', text: `Каким был ночной добор («Daily top-up») ${before}, не записалось.` });
  } else {
    const wasOn = Object.entries(refill)
      .filter(([, v]) => v === 'on')
      .map(([id]) => siteById.get(id) ?? id);
    const unknownIds = Object.entries(refill)
      .filter(([, v]) => v === 'unknown')
      .map(([id]) => siteById.get(id) ?? id);
    if (wasOn.length > 0) {
      lines.push({
        tone: 'note',
        text: `${Before} ночной добор («Daily top-up») был включён: ${wasOn.join(', ')}. Включает его снова только сам клиент.`,
      });
    }
    if (unknownIds.length > 0) {
      lines.push({ tone: 'note', text: `${Before} ночной добор не прочитался: ${unknownIds.join(', ')}.` });
    }
  }

  if (r.research === null) {
    lines.push({
      tone: 'note',
      text: 'Не прочиталось, в каком состоянии исследование проектов клиента, — смотрите раздел «Проект» карточки.',
    });
  } else {
    for (const p of r.research) {
      lines.push({ tone: 'note', text: `Проект ${p.website ?? p.project_id}: ${RESEARCH_RESTART_TEXT[p.restart]}.` });
    }
  }
  return lines;
}

/* ─────────────── Исследование проектов: кто снова запустит ─────────────── */

export type HeEngAccountResearchRead =
  | {
      ok: true;
      /** us-проекты аккаунта; `restart` null — исследован ('researched'). */
      projects: Array<{ id: string; website: string | null; status: string; restart: HeEngResearchRestart | null }>;
    }
  | { ok: false };

/** Вердикт шага 1 (researchJob.engResearchRetryVerdict) → кто снова запустит исследование. */
function researchRestartOf(
  verdict: ReturnType<typeof engResearchRetryVerdict>,
  status: unknown,
  errorCode: unknown,
): HeEngResearchRestart | null {
  switch (verdict) {
    case 'finished':
      return null;
    case 'running':
    case 'settling':
      return 'running';
    case 'retry_stalled':
      return 'try_again';
    case 'retry_failed':
      // Шаг 1 у 'billing' / 'configuration' сначала зовёт в Support, потом «Try again».
      return status === 'failed' && (errorCode === 'billing' || errorCode === 'configuration') ? 'team_fix' : 'try_again';
    case 'not_technical':
      return 'team';
  }
}

/**
 * us-проекты аккаунта и кто снова запустит исследование каждого не
 * исследованного: то же чтение (readLatestHeResearchJob) и та же функция
 * (engResearchRetryVerdict, окно HE_RESEARCH_STALL_GRACE_MS), что у деталки
 * проекта, по которой шаг 1 рисует «Try again». Колонки отметки отмены нет
 * (миграция 20261009_0002) — вердикт берёт updated_at, как у деталки. Сбой
 * любого чтения — { ok: false }. НЕ БРОСАЕТ. Зовут: отчёт разблокировки и
 * письмо «Sending is on» (api/admin/users/[id]/eng-sending).
 */
export async function readHeEngAccountResearch(
  db: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<HeEngAccountResearchRead> {
  try {
    const columns = 'id, website_url, status, error, created_at, updated_at';
    const read = (cols: string) =>
      db.from('he_projects').select(cols).eq('created_by', userId).eq('market', 'us').limit(1000);
    let res = await read(`${columns}, cancelled_at`);
    if (res.error && isHeMissingColumnError(res.error)) res = await read(columns);
    if (res.error) {
      void logWarn('he.eng_account_research.projects_read_failed', pgText('he_projects read', res.error), { userId });
      return { ok: false };
    }
    const rows = ((res.data ?? []) as unknown as Array<Record<string, unknown>>).filter(
      (p) => typeof p.id === 'string' && p.id.length > 0,
    );
    const projects = await Promise.all(
      rows.map(async (p) => {
        const id = p.id as string;
        const status = typeof p.status === 'string' ? p.status : '';
        const website = websiteLabel(p.website_url);
        if (status === 'researched') return { id, website, status, restart: null };
        const last = await readLatestHeResearchJob(db, id);
        if (!last.ok) return null;
        const errorCode = toClientEngStageErrorCode(p.error);
        const verdict = engResearchRetryVerdict({
          status: p.status,
          errorCode,
          lastResearchJob: last.job,
          project: p,
          now: now.getTime(),
          graceMs: HE_RESEARCH_STALL_GRACE_MS,
        });
        return { id, website, status, restart: researchRestartOf(verdict, p.status, errorCode) };
      }),
    );
    if (projects.some((p) => p === null)) {
      void logWarn('he.eng_account_research.job_read_failed', 'latest research job read failed', { userId });
      return { ok: false };
    }
    return { ok: true, projects: projects as Array<NonNullable<(typeof projects)[number]>> };
  } catch (e) {
    void logWarn('he.eng_account_research.threw', e instanceof Error ? e.message.slice(0, 300) : 'unknown', { userId });
    return { ok: false };
  }
}

/* ─────────────── Блокировка ─────────────── */

export interface HeEngBlockResult {
  report: HeEngBlockReport;
  /** Строки отчёта + строка о сохранении отчёта. */
  lines: HeEngBlockLine[];
  /** Одна фраза: что не остановилось; null — всё остановлено. */
  error: string | null;
  /** Срок бана из ответа GoTrue; null — бан не поставился (или ответ без него). */
  bannedUntil: string | null;
  reportSaved: HeEngAccountBlockReportWrite | 'timeout';
}

/** Заблокировать ENG-клиента (шапка модуля). НЕ БРОСАЕТ. */
export async function blockHeEngAccount(input: {
  portalDb: SupabaseClient;
  /** null — БД рассыльщика не настроена: паузы нет, строка отчёта красная. */
  instantlyDb: SupabaseClient | null;
  userId: string;
  staffUserId: string | null;
  now?: Date;
  timing?: Partial<HeEngBlockTiming>;
}): Promise<HeEngBlockResult> {
  const { portalDb, instantlyDb, userId, staffUserId } = input;
  const env: StepEnv = {
    portalDb,
    userId,
    staffUserId,
    now: input.now ?? new Date(),
    timing: { ...HE_ENG_BLOCK_TIMING, ...(input.timing ?? {}) },
    ctx: { userId, staffUserId },
  };

  // 0. Чтения «до».
  const projectsP = readProjectsStep(env);
  const before = await readStateBefore(env, projectsP);
  const projectsRead = await projectsP;

  // 1. Отметка — первой записью. Повтор в эпизоде, который открыла
  // «Разблокировать», несёт этот признак в отчёт (карточка, last_stop).
  const marked = await markStep(env, before);
  const marker = marked.state;
  const openedByUnblock = marked.mark.state === 'repeat' && marked.mark.row.openedBy === 'unblock';

  // 2a. Выключатель отправки.
  const sendingSwitch = (await revokeSendingStep(env)).outcome;

  // 2b. Пауза кампаний — параллельно с входом, проектами и письмами.
  const pauseP = pauseCampaignsStep(env, instantlyDb);
  const rest = (async () => {
    let bannedUntil: string | null = null;
    const ban = await step<'ok' | 'failed'>('ban', env.timing.authMs, 'failed', async () => {
      const { data, error } = await portalDb.auth.admin.updateUserById(userId, { ban_duration: HE_ENG_BLOCK_BAN_DURATION });
      if (error) {
        void logWarn('he.eng_block.ban_failed', String(error.message ?? 'unknown').slice(0, 300), env.ctx);
        return 'failed';
      }
      bannedUntil = data?.user?.banned_until ?? null;
      return 'ok';
    }, env.ctx);
    const sessions = await step<'ok' | 'failed'>('sessions', env.timing.stepMs, 'failed', async () => {
      const { error } = await portalDb.rpc('admin_revoke_user_sessions', { target_user_id: userId });
      if (error) {
        void logWarn('he.eng_block.sessions_failed', pgText('admin_revoke_user_sessions', error), env.ctx);
        return 'failed';
      }
      return 'ok';
    }, env.ctx);
    // 2c–2d.
    const projects = await stopProjectsStep(env, projectsRead);
    const clientEmails = await closeEmailsStep(env);
    return { ban, sessions, bannedUntil: bannedUntil as string | null, projects, clientEmails };
  })();
  const [campaigns, done] = await Promise.all([pauseP, rest]);

  const partial: Omit<HeEngBlockReport, 'complete'> = {
    marker,
    sending_switch: sendingSwitch,
    ban: done.ban,
    sessions: done.sessions,
    projects_read: projectsRead.kind === 'ok' ? 'ok' : 'failed',
    projects: done.projects,
    client_emails: done.clientEmails,
    campaigns,
  };
  const report: HeEngBlockReport = {
    complete: heEngBlockComplete(partial),
    ...(openedByUnblock ? { opened_by: 'unblock' as const } : {}),
    ...partial,
  };
  const failedSteps = heEngBlockFailedSteps(partial);
  const email = before.access?.email ?? null;

  // 3. Отчёт, аудит (с состояниями «до» этого нажатия), алерт.
  const saved = await step<HeEngAccountBlockReportWrite | 'timeout'>('report', env.timing.stepMs, 'timeout', () =>
    writeHeEngAccountBlockReport(portalDb, { userId, blockAt: env.now, report }), env.ctx);
  void logAudit(
    'admin.users.block.eng_stop',
    report.complete ? 'ENG client blocked, everything stopped' : 'ENG client blocked, part of the work did not stop',
    {
      targetUserId: userId,
      report,
      reportSaved: saved,
      failed: failedSteps,
      sendingBefore: before.sendingBefore,
      refillEnabledBefore: before.refillBefore,
    },
    { userId: staffUserId ?? undefined },
  );
  if (failedSteps.length > 0) void notifyHeEngSending({ kind: 'block_incomplete', userId, email, failed: failedSteps });
  if (campaigns.unreachable.length > 0) {
    void notifyHeEngSending({
      kind: 'campaigns_unreachable',
      userId,
      email,
      where: 'block',
      campaigns: campaigns.unreachable.map(heEngUnreachableText),
    });
  }

  const lines = heEngBlockReportLines(report);
  if (saved === 'superseded') {
    lines.push({
      tone: 'note',
      text: 'Пока шла эта остановка, «Заблокировать» нажали ещё раз — в карточке сохранён отчёт того нажатия.',
    });
  } else if (saved !== 'ok') {
    lines.push({
      tone: 'note',
      text: 'Отчёт не сохранился в карточке клиента — он только здесь и в журнале действий.',
    });
  }
  return {
    report,
    lines,
    error: failedSteps.length > 0 ? `Не остановилось: ${failedSteps.join('; ')}.` : null,
    bannedUntil: done.bannedUntil,
    reportSaved: saved,
  };
}

/* ─────────────── Разблокировка ─────────────── */

export interface HeEngUnblockResult {
  report: HeEngUnblockReport;
  lines: HeEngBlockLine[];
  /** Одна фраза: что не вышло; null — всё. */
  error: string | null;
  bannedUntil: string | null;
}

export type HeEngUnblockOutcome =
  /** Ни активной отметки, ни бана — разблокировать нечего, ничего не тронуто. */
  | { kind: 'not_blocked' }
  /** Бан не прочитался, а активной отметки не видно — ничего не тронуто. */
  | { kind: 'standing_unread' }
  | ({ kind: 'done' } & HeEngUnblockResult);

/** Бан в GoTrue действует (непарсящийся срок — тоже бан, как у readHeEngAccountStanding). */
function banActive(bannedUntil: unknown, nowMs: number): boolean {
  const raw = typeof bannedUntil === 'string' ? bannedUntil.trim() : '';
  if (!raw) return false;
  const until = Date.parse(raw);
  return !Number.isFinite(until) || until > nowMs;
}

/**
 * Перед снятием бана: отметка всё ещё та, что снимает это нажатие? 'ours' —
 * активной отметки нет или её last_block_at равен эпизоду (`episodeAt`);
 * 'moved' — не равен: пока шла разблокировка, нажали «Заблокировать»;
 * 'unknown' — не прочиталась, или у нажатия эпизода нет, а активная отметка
 * есть (чья — не отличить). Таблицы нет — у нажатия без эпизода 'ours'.
 */
async function recheckEpisode(db: SupabaseClient, userId: string, episodeAt: string | null): Promise<'ours' | 'moved' | 'unknown'> {
  const read = await readHeEngAccountBlockRows(db, [userId]);
  if (read.state === 'missing') return episodeAt === null ? 'ours' : 'unknown';
  if (read.state === 'error') return 'unknown';
  const row = read.rows.get(userId);
  if (!row || !row.active) return 'ours';
  if (episodeAt === null) return 'unknown';
  const now = Date.parse(row.lastBlockAt);
  const mine = Date.parse(episodeAt);
  if (!Number.isFinite(now) || !Number.isFinite(mine)) return 'unknown';
  return now === mine ? 'ours' : 'moved';
}

/** Разблокировать ENG-клиента: остановка до снятия бана, затем только вход (шапка модуля). НЕ БРОСАЕТ. */
export async function unblockHeEngAccount(input: {
  portalDb: SupabaseClient;
  /** null — БД рассыльщика не настроена: паузу не подтвердить, бан не снимается. */
  instantlyDb: SupabaseClient | null;
  userId: string;
  staffUserId: string | null;
  now?: Date;
  timing?: Partial<HeEngBlockTiming>;
}): Promise<HeEngUnblockOutcome> {
  const { portalDb, instantlyDb, userId, staffUserId } = input;
  const env: StepEnv = {
    portalDb,
    userId,
    staffUserId,
    now: input.now ?? new Date(),
    timing: { ...HE_ENG_UNBLOCK_TIMING, ...(input.timing ?? {}) },
    ctx: { userId, staffUserId },
  };

  // 0. Заблокирован ли: бан ∥ строка отметки (с last_stop — кто открыл эпизод) ∥ проекты аккаунта.
  const banP = step<boolean | null>('ban_read', env.timing.authMs, null, async () => {
    const { data, error } = await portalDb.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    return banActive(data.user.banned_until, Date.now());
  }, env.ctx);
  const rowsP = step<HeEngAccountBlockRowsRead>(
    'unblock_rows_read',
    env.timing.stepMs,
    { state: 'error', detail: 'timeout or throw', code: null },
    () => readHeEngAccountBlockRows(portalDb, [userId], { withReport: true }),
    env.ctx,
  );
  const projectsP = readProjectsStep(env);
  const [banned, rows] = await Promise.all([banP, rowsP]);
  const row = rows.state === 'ok' ? (rows.rows.get(userId) ?? null) : null;
  const markerBefore: HeEngUnblockReport['marker_before'] =
    rows.state === 'missing' ? 'missing' : rows.state === 'error' ? 'unread' : row?.active ? 'active' : 'none';
  if (markerBefore !== 'active' && banned !== true) {
    // Не заблокирован (или не прочитать) — остановка живого клиента из
    // устаревшей карточки была бы ошибкой сотрудника, а не разблокировкой.
    if (banned === false && markerBefore !== 'unread') return { kind: 'not_blocked' };
    return { kind: 'standing_unread' };
  }

  // 1. Отметки нет — как «Заблокировать»: чтения «до» и отметка (шаги 0–1),
  // с признаком «эпизод открыла разблокировка». Эпизод этого нажатия —
  // last_block_at прочитанной или записанной здесь отметки; null — своей
  // отметки у нажатия нет (таблицы нет, не прочиталась, не записалась).
  let markerWritten: HeEngUnblockReport['marker_written'] = null;
  let openedBy: HeEngUnblockReport['opened_by'] = row?.active ? (row.openedBy ?? 'block') : null;
  let sendingBefore: HeEngSendingBefore | null = row?.active ? row.sendingBefore : null;
  let refillBefore: HeEngRefillBeforeMap | null = row?.active ? row.refillEnabledBefore : null;
  let episodeAt: string | null = row?.active ? row.lastBlockAt : null;
  let email: string | null = null;
  if (markerBefore === 'none') {
    const before = await readStateBefore(env, projectsP);
    email = before.access?.email ?? null;
    const marked = await markStep(env, before, 'unblock');
    // 'taken' — отметку по ходу завело другое нажатие: «до» и эпизод — его
    // (завела «Заблокировать» — бан ниже не снимается: 'reblocked').
    const markedRow = marked.mark.state === 'new' || marked.mark.state === 'taken' ? marked.mark.row : null;
    markerWritten = marked.mark.state === 'taken' ? 'taken' : marked.state;
    if (marked.mark.state === 'taken') openedBy = marked.mark.row.openedBy ?? 'block';
    sendingBefore = markedRow ? markedRow.sendingBefore : before.sendingBefore;
    refillBefore = markedRow ? markedRow.refillEnabledBefore : before.refillBefore;
    episodeAt = markedRow ? markedRow.lastBlockAt : null;
  }
  const reblockedMeanwhile = markerWritten === 'taken' && openedBy === 'block';
  const projectsRead = await projectsP;

  // 2. Остановка a–d. Кампании, чья пауза прочитана после начала эпизода (и
  // не раньше окна перечитывания фоновой проверки), засчитываются без вызова.
  const sw = await revokeSendingStep(env);
  email = email ?? sw.email;
  const episodeMs = episodeAt !== null ? Date.parse(episodeAt) : Number.NaN;
  const confirmedSinceMs = Number.isFinite(episodeMs)
    ? Math.max(episodeMs, Date.now() - HE_ENG_BLOCK_SWEEP_RECHECK_MS)
    : undefined;
  const [campaigns, work] = await Promise.all([
    pauseCampaignsStep(env, instantlyDb, confirmedSinceMs),
    (async () => ({ projects: await stopProjectsStep(env, projectsRead), clientEmails: await closeEmailsStep(env) }))(),
  ]);
  const stopReport: HeEngAccountStopReport = {
    sending_switch: sw.outcome,
    projects_read: projectsRead.kind === 'ok' ? 'ok' : 'failed',
    projects: work.projects,
    client_emails: work.clientEmails,
    campaigns,
  };
  const confirmed = heEngAccountStopConfirmed(stopReport);
  const base = {
    marker_before: markerBefore,
    opened_by: openedBy,
    ban_before: banned,
    marker_written: markerWritten,
    stop: { ...stopReport, confirmed },
    sending_before: sendingBefore,
    refill_enabled_before: refillBefore,
  };
  if (campaigns.unreachable.length > 0) {
    void notifyHeEngSending({
      kind: 'campaigns_unreachable',
      userId,
      email,
      where: 'unblock',
      campaigns: campaigns.unreachable.map(heEngUnreachableText),
    });
  }
  const kept = (keptBy: NonNullable<HeEngUnblockReport['kept_by']>, failed: string[]): HeEngUnblockOutcome => {
    const report: HeEngUnblockReport = {
      complete: false,
      ...base,
      ban: 'kept',
      kept_by: keptBy,
      marker: 'skipped',
      reban: null,
      research: null,
    };
    void logAudit(
      'admin.users.unblock.eng',
      `ENG client unblock refused (${keptBy}): the block stays`,
      { targetUserId: userId, report, failed },
      { userId: staffUserId ?? undefined },
    );
    const lines = heEngUnblockReportLines(report);
    return {
      kind: 'done',
      report,
      lines,
      error:
        keptBy === 'stop'
          ? `${notLiftedText(report)} — не остановилось: ${failed.join('; ')}. Нажмите ${AGAIN_UNBLOCK}.`
          : lines[0].text,
      bannedUntil: null,
    };
  };

  // «Заблокировать» завело отметку, пока шла эта разблокировка, — его решение новее.
  if (reblockedMeanwhile) return kept('reblocked', []);
  // Не подтверждена — бан остаётся, больше ничего не снимается.
  if (!confirmed) {
    const failed = stopFailedSteps(stopReport);
    void notifyHeEngSending({ kind: 'unblock_incomplete', userId, email, failed, banBefore: banned });
    return kept('stop', failed);
  }

  // 3. Перед снятием бана — не нажали ли «Заблокировать», пока шла остановка.
  const recheck = await step<'ours' | 'moved' | 'unknown'>('unblock_recheck', env.timing.stepMs, 'unknown', () =>
    recheckEpisode(portalDb, userId, episodeAt), env.ctx);
  if (recheck !== 'ours') return kept(recheck === 'moved' ? 'reblocked' : 'unverified', []);

  // 4. Снятие бана, затем условное снятие отметки эпизода (бан снова, если её
  // сдвинуло «Заблокировать») — параллельно с чтением исследования проектов.
  const researchP = step<HeEngAccountResearchRead>('research_read', env.timing.stepMs * 2, { ok: false }, () =>
    readHeEngAccountResearch(portalDb, userId, env.now), env.ctx);
  let bannedUntil: string | null = null;
  const ban = await step<'lifted' | 'failed'>('unban', env.timing.authMs, 'failed', async () => {
    const { data, error } = await portalDb.auth.admin.updateUserById(userId, { ban_duration: 'none' });
    if (error) {
      void logWarn('he.eng_unblock.ban_failed', String(error.message ?? 'unknown').slice(0, 300), env.ctx);
      return 'failed';
    }
    bannedUntil = data?.user?.banned_until ?? null;
    return 'lifted';
  }, env.ctx);
  let marker: HeEngUnblockReport['marker'] = 'skipped';
  let reban: HeEngUnblockReport['reban'] = null;
  if (ban === 'lifted') {
    // unblocked_at — момент снятия, а не начала нажатия: выключатель, который
    // выключила остановка выше (revoked_at — время её записи), должен быть не
    // позже разблокировки — по этому карточка (heEngAdminSendingOffBy) и письмо
    // «Sending is on» (eng-sending) узнают выключение блокировкой.
    const res = await step<HeEngAccountUnblockMark>(
      'unmark',
      env.timing.stepMs,
      { state: 'error', detail: 'timeout or throw', code: null },
      () => markHeEngAccountUnblocked(portalDb, { userId, staffUserId, now: new Date(), episodeAt }),
      env.ctx,
    );
    marker =
      res.state === 'unblocked'
        ? 'cleared'
        : res.state === 'error'
          ? 'failed'
          : res.state;
    if (marker === 'superseded') {
      // Отметку сдвинуло «Заблокировать», нажатое по ходу, — его бан мог лечь
      // раньше снятия здесь: ставим снова.
      reban = await step<'ok' | 'failed'>('reban', env.timing.authMs, 'failed', async () => {
        const { error } = await portalDb.auth.admin.updateUserById(userId, { ban_duration: HE_ENG_BLOCK_BAN_DURATION });
        if (error) {
          void logWarn('he.eng_unblock.reban_failed', String(error.message ?? 'unknown').slice(0, 300), env.ctx);
          return 'failed';
        }
        return 'ok';
      }, env.ctx);
    }
  }
  const research = await researchP;
  const markerDone = marker === 'cleared' || marker === 'not_blocked' || marker === 'missing';
  const report: HeEngUnblockReport = {
    complete: ban === 'lifted' && markerDone && campaigns.unreachable.length === 0,
    ...base,
    ban,
    kept_by: null,
    marker,
    reban,
    research: research.ok
      ? research.projects.flatMap((p) => (p.restart ? [{ project_id: p.id, website: p.website, restart: p.restart }] : []))
      : null,
  };
  void logAudit(
    'admin.users.unblock.eng',
    ban === 'lifted' && markerDone
      ? 'ENG client unblocked: the stop re-asserted, login only'
      : marker === 'superseded'
        ? 'ENG client unblock overtaken by a block pressed meanwhile: the ban is set again'
        : 'ENG client unblock not complete',
    { targetUserId: userId, report },
    { userId: staffUserId ?? undefined },
  );
  const lines = heEngUnblockReportLines(report);
  return {
    kind: 'done',
    report,
    lines,
    error:
      ban !== 'lifted' || marker === 'superseded'
        ? lines[0].text
        : marker === 'failed'
          ? 'Вход открыт, но отметка блокировки не снята — нажмите «Разблокировать» ещё раз.'
          : null,
    bannedUntil: ban === 'lifted' && marker !== 'superseded' ? bannedUntil : null,
  };
}
