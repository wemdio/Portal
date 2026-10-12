/**
 * ENG: автозапуск — ОДНА кнопка «Launch» доводит проект до отправки (S3,
 * решение владельца 10.10.2026: «запуски супер простые, в пару кнопок»;
 * миграция 20261012_0001_he_eng_auto_launch.sql — таблицы, состояния, права).
 *
 * КАК ЭТО РАБОТАЕТ.
 *  1. Клиент нажимает «Launch» на шаге 3 (POST api/client/eng/projects/[id]/
 *     launch): записывается НАМЕРЕНИЕ (writeHeEngLaunchIntent: wanted, окно
 *     отправки) и ставятся недостающие платные стадии тем же путём, что
 *     «Start outreach» (autopilotReconcile, trigger 'client').
 *  2. Автопилот воркера (без изменений) доводит каждую выбранную вертикаль до
 *     готового шаблона.
 *  3. Тик воркера движка (runHeEngAutoLaunchTick, не чаще раза в
 *     HE_ENG_AUTO_LAUNCH_TICK_MS, между джобами) берёт готовый шаблон и
 *     запускает его ТЕМ ЖЕ вызовом, что кнопка «Launch now»: аккаунт
 *     (readHeEngAccountStanding — та часть requireClientAuth кнопки, что не
 *     про сессию: бан, роль, демо) → requireEngMarket → loadClientHeTemplate →
 *     engClientLaunch.runHeEngTemplateLaunch (trigger 'auto', startSending:
 *     true, окно намерения — для ПЕРВОГО запуска рынка; достройка берёт своё
 *     окно рынка) — со всеми гейтами кнопки: гейт платных шагов,
 *     выключатель отправки аккаунта, пул ящиков, лимит неудачных запусков,
 *     гейт писем и защиты аудитории ядра, чёрный список, окно США, удержание
 *     сегментов, перед стартом — снова аккаунт, отмена автозапуска проекта и
 *     запись решения «стартуем» (heEngStartGate), пауза клиента
 *     (startHeEngLaunchSending via 'launch').
 *  4. Итог — строка he_eng_auto_launch (heEngAutoLaunchVerdict: состояние,
 *     код, когда снова), письмо клиенту (при подключённом почтовом модуле) и
 *     алерт команде, если строка встала насовсем.
 *
 * НЕ БОЛЬШЕ ОДНОГО ЗАПУСКА НА ШАБЛОН И ВЕРТИКАЛЬ:
 *  - строку берёт атомарная функция he_eng_auto_launch_claim (часы БД, аренда
 *    HE_ENG_AUTO_LAUNCH_LEASE_SECONDS); кнопка «Launch now» берёт ту же строку
 *    (manual) — кнопка и тик не запускают шаблон одновременно;
 *  - ядро держит свою аренду записи о запуске (15 мин) и отвечает 409 «уже
 *    запущено» на законченный запуск; вертикаль с законченным запуском
 *    кандидатом не бывает (heEngAutoLaunchCandidates), а ядро отказывает
 *    второму шаблону той же базы ('sibling_template_launched');
 *  - старт кампаний идемпотентен (уже отправляющая — `alreadySending`).
 *
 * ПЛАТНАЯ РАБОТА. Тик ничего платного НЕ ставит: стадии ставит только
 * нажатие «Launch» клиента. Единственная платная часть запуска —
 * классификатор сегментов ядра — ограничена дважды: лимитом неудачных
 * запусков шаблона (3 в час, engRateLimit) и paid_failures ≤ 3 на шаблон
 * (дальше строка 'failed', и её поднимает только новое «Launch» клиента —
 * его решение платить снова). Попытка, брошенная посреди (процесс умер, строка
 * 'running' с истёкшей арендой), считается платным сбоем при следующем взятии
 * (код 'abandoned'); вторая брошенная подряд — 'failed' без нового запуска.
 *
 * СТАРТ ПОСЛЕ ОБРЫВА. Брошенная строка над ЗАКОНЧЕННЫМ запуском стартует
 * кампании (только старт, без ядра), лишь если решение «стартуем» было
 * записано ('start_pending', 'start_retry' или 'held account_blocked');
 * иначе — 'done needs_support', и ничего не стартует (обрыв мог прийти до
 * пропуска старта: окно не встало, старый бандл кнопки без start_sending).
 *
 * КАЖДЫЙ ПРОЕКТ БУДЕТ ОБСЛУЖЕН. Тик читает только ОТКРЫТЫЕ намерения (wanted,
 * без settled_at) проходами с вращающимся курсором и бюджетом прохода
 * (readOpenIntentsPass); исполненное намерение (heEngLaunchSettled) получает
 * settled_at и больше не читается, новое «Launch» снимает отметку.
 *
 * ОТМЕНА ПОСРЕДИ ПОПЫТКИ. «Cancel all jobs», пришедший, пока тик запускает
 * рынок, останавливает старт: проверка перед стартом перечитывает намерение и
 * проект ('done cancelled', без письма); созданное ядром остаётся на паузе.
 *
 * ЗАБЛОКИРОВАННЫЙ АККАУНТ (бан Supabase, роль не client/admin, демо) — новый
 * запуск и старт не начинаются ('held account_blocked', перепроверка раз в
 * час, один алерт команде на рынок, письма клиенту нет); уже отправляющие
 * кампании не трогаются.
 *
 * ДЕГРАДАЦИЯ. Нет таблиц / функции миграции — намерение 'missing': «Launch»
 * проекта стадии ставит, отвечает auto_launch 'unavailable'; тик не делает
 * ничего (одна строка warn на процесс); кнопка «Launch now» идёт без замка, как
 * до S3. Отправка за всеми гейтами S2 в любом случае (fail-closed).
 *
 * НЕ БРОСАЕТ: каждый исход — значение.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit, logWarn } from '@/lib/loggerServer';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';
import {
  engDefaultSendingWindow,
  parseEngSendingWindow,
  toClientEngSendingWindow,
} from '@/app/api/client/eng/_launchWindow';
import { loadClientHeTemplate, requireEngMarket } from './apiGuards';
import {
  ENG_START_GATE_FAILED_TEXT,
  retryHeEngLaunchStart,
  runHeEngTemplateLaunch,
  type HeEngLaunchSendingVerdict,
  type HeEngLaunchSummary,
  type HeEngStartGateResult,
} from './engClientLaunch';
import { heEngSendingAccessAllows, readHeEngSendingAccess } from './engSendingAccess';
import { notifyHeEngSending } from './engSendingAlert';
import { heLaunchIsIncomplete, parseLaunchInfo, readHeLaunchLease } from './launchHandoff';
import { isHeMissingColumnError } from './projectCancelMarker';

/* ─────────────── Имена и настройки ─────────────── */

export const HE_ENG_LAUNCH_INTENT_TABLE = 'he_eng_launch_intent';
export const HE_ENG_AUTO_LAUNCH_TABLE = 'he_eng_auto_launch';
export const HE_ENG_AUTO_LAUNCH_CLAIM_RPC = 'he_eng_auto_launch_claim';
/** Выключатель автозапуска в воркере: '0' / 'false' / 'off' / 'no' — выключен (письма — нет). */
export const HE_ENG_AUTO_LAUNCH_ENV = 'HE_ENG_AUTO_LAUNCH';
/** Как часто воркер заходит в тик (мс); дефолт — минута. */
export const HE_ENG_AUTO_LAUNCH_TICK_MS_ENV = 'HE_ENG_AUTO_LAUNCH_TICK_MS';
export const HE_ENG_AUTO_LAUNCH_TICK_MS_DEFAULT = 60_000;
/**
 * Строка 'waiting' без кода старше этого — кабинет пишет «Starting is taking
 * longer than usual» и показывает «Launch now» (автозапуск выключен, воркер
 * старше портала, тик встал).
 */
export const HE_ENG_AUTO_LAUNCH_STALE_MS = 20 * 60_000;
/**
 * Аренда строки взявшим. Запуск обычно — несколько минут (ядро: классификатор
 * и вызовы рассыльщика по 90 с; старт: 100 с срока); пока он идёт, взявший
 * (тик или кнопка) продлевает аренду (startHeEngAutoLaunchLeaseHeartbeat).
 * После смерти процесса строка снова берётся по истечении.
 */
export const HE_ENG_AUTO_LAUNCH_LEASE_SECONDS = 600;

/** Бюджет прохода тика: сколько ОТКРЫТЫХ намерений он читает (readOpenIntentsPass). */
const INTENTS_PER_PASS = 200;
/** Страница чтения намерений внутри прохода. */
const INTENT_PAGE = 50;
/** Пачка id в `in(...)`: длина URL PostgREST. */
const ID_CHUNK = 50;
/** Сколько раз за тик пробуем взять строку, если её перехватили. */
const CLAIMS_PER_TICK = 3;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Включён ли автозапуск в этом процессе (дефолт — да). */
export function heEngAutoLaunchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF_VALUES.has((env[HE_ENG_AUTO_LAUNCH_ENV] ?? '').trim().toLowerCase());
}

/** Период тика воркера (мс): число ≥ 5 000 из переменной, иначе дефолт. */
export function heEngAutoLaunchTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[HE_ENG_AUTO_LAUNCH_TICK_MS_ENV]);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : HE_ENG_AUTO_LAUNCH_TICK_MS_DEFAULT;
}

/** «Launch now» нажат, пока шаблон уже запускается (тиком или другой вкладкой). */
export const ENG_LAUNCH_BUSY_TEXT =
  'This market is being launched right now. Wait a minute and refresh the page to see how it went.';

/* ─────────────── Состояния и коды ─────────────── */

export type HeEngAutoLaunchState = 'waiting' | 'running' | 'done' | 'held' | 'failed';

/**
 * Закрытый словарь причин строки (кабинет пишет текст по коду, письма — по
 * своему коду). Смысл каждого — в таблице heEngAutoLaunchVerdict.
 */
export const HE_ENG_AUTO_LAUNCH_CODES = [
  'start_retry',
  'start_failed',
  'client_paused',
  'needs_support',
  'unfinished',
  'email_not_verified',
  'spend_limit',
  'spend_day_limit',
  'unavailable',
  'sending_not_enabled',
  'sending_turned_off',
  'mailboxes_short',
  'setup_unavailable',
  'retry_limited',
  'research_running',
  'launch_running',
  'letters_need_rewrite',
  'server_error',
  'launch_failed',
  /** На строке 'running': взявший решил стартовать кампании (heEngStartGate). */
  'start_pending',
  /** Попытка брошена посреди (процесс умер) — платный сбой; 'failed' — сдались. */
  'abandoned',
  /** Аккаунт заблокирован (бан, роль, демо) — 'held', перепроверка раз в час. */
  'account_blocked',
  /**
   * «Cancel all jobs» пришёл посреди попытки тика (heEngStartGate): кампании
   * созданы, старт не делался — 'done'; новое «Launch» возвращает строку в
   * 'waiting'.
   */
  'cancelled',
] as const;
export type HeEngAutoLaunchCode = (typeof HE_ENG_AUTO_LAUNCH_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set<string>(HE_ENG_AUTO_LAUNCH_CODES);
const STATE_SET: ReadonlySet<string> = new Set<string>(['waiting', 'running', 'done', 'held', 'failed']);

/** Строка he_eng_auto_launch (как пришла из БД). */
export interface HeEngAutoLaunchRow {
  template_id: string;
  project_id: string;
  state: HeEngAutoLaunchState;
  code: HeEngAutoLaunchCode | null;
  attempts: number;
  retries: number;
  paid_failures: number;
  start_retries: number;
  next_at: string;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_COLUMNS =
  'template_id, project_id, state, code, attempts, retries, paid_failures, start_retries, next_at, lease_until, created_at, updated_at';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function tsOf(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

function toRow(raw: unknown): HeEngAutoLaunchRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const templateId = str(r.template_id);
  if (!templateId || !STATE_SET.has(str(r.state))) return null;
  return {
    template_id: templateId,
    project_id: str(r.project_id),
    state: r.state as HeEngAutoLaunchState,
    code: CODE_SET.has(str(r.code)) ? (r.code as HeEngAutoLaunchCode) : null,
    attempts: count(r.attempts),
    retries: count(r.retries),
    paid_failures: count(r.paid_failures),
    start_retries: count(r.start_retries),
    next_at: str(r.next_at),
    lease_until: str(r.lease_until) || null,
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

interface PgError {
  code?: string | null;
  message?: string | null;
}

/**
 * Миграции нет (таблица, функция или колонка): 42P01 / PGRST205 — таблица,
 * 42883 / PGRST202 — функция, 42703 / PGRST204 — колонка.
 */
function isMissing(error: PgError | null | undefined): boolean {
  const code = error?.code ?? '';
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === '42883' ||
    code === 'PGRST202' ||
    isHeMissingColumnError(error as { code?: string } | null)
  );
}

function errText(prefix: string, error: PgError | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

/** Одна строка warn на процесс по ключу — тик ходит раз в минуту. */
const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string, context: Record<string, unknown> = {}): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  void logWarn(`he.eng_auto_launch.${key}`, message, context);
}

/* ─────────────── Намерение клиента ─────────────── */

export interface HeEngLaunchIntent {
  projectId: string;
  userId: string;
  wanted: boolean;
  /** Окно как записано (проверяет parseEngSendingWindow при каждом чтении). */
  schedule: unknown;
  requestedAt: string;
  cancelledAt: string | null;
}

export type HeEngIntentRead =
  | { kind: 'ok'; intent: HeEngLaunchIntent | null }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const INTENT_COLUMNS = 'project_id, user_id, wanted, schedule, requested_at, cancelled_at';

function toIntent(raw: unknown): HeEngLaunchIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const projectId = str(r.project_id);
  const userId = str(r.user_id);
  if (!projectId || !userId) return null;
  return {
    projectId,
    userId,
    wanted: r.wanted === true,
    schedule: r.schedule ?? null,
    requestedAt: str(r.requested_at),
    cancelledAt: str(r.cancelled_at) || null,
  };
}

/** Окно намерения, годное для запуска: записанное и проверенное, иначе дефолт кабинета. */
export function heEngIntentSendingWindow(intent: HeEngLaunchIntent | null): ClientLaunchScheduleOverride {
  const parsed = intent ? parseEngSendingWindow(intent.schedule) : null;
  return parsed && parsed.ok ? parsed.window : engDefaultSendingWindow();
}

export async function readHeEngLaunchIntent(db: SupabaseClient, projectId: string): Promise<HeEngIntentRead> {
  try {
    const { data, error } = await db
      .from(HE_ENG_LAUNCH_INTENT_TABLE)
      .select(INTENT_COLUMNS)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) {
      if (isMissing(error)) return { kind: 'missing' };
      return { kind: 'error', message: errText('he_eng_launch_intent read', error) };
    }
    return { kind: 'ok', intent: toIntent(data) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}

/**
 * «Launch» проекта: намерение включено, окно и время нажатия записаны, отмена
 * и отметка «исполнено» (settled_at, см. heEngLaunchSettled) сняты — тик снова
 * читает проект. Повторное нажатие — решение клиента начать заново: строки
 * 'failed' и 'done cancelled' (старт отменён «Cancel all jobs» посреди
 * попытки) возвращаются в 'waiting' с обнулёнными счётчиками (в том числе
 * платных сбоев — клиент решил заплатить снова), у строк 'held' срок проверки —
 * сейчас. Остальные строки 'done' не трогаются: дальше отправкой правят кнопки
 * блока отправки. Сброс строк — best-effort (warn): намерение важнее.
 */
export async function writeHeEngLaunchIntent(
  db: SupabaseClient,
  args: { projectId: string; userId: string; schedule: ClientLaunchScheduleOverride; now?: Date },
): Promise<'ok' | 'missing' | 'error'> {
  const nowIso = (args.now ?? new Date()).toISOString();
  try {
    const { error } = await db.from(HE_ENG_LAUNCH_INTENT_TABLE).upsert(
      {
        project_id: args.projectId,
        user_id: args.userId,
        wanted: true,
        schedule: toClientEngSendingWindow(args.schedule),
        requested_at: nowIso,
        cancelled_at: null,
        settled_at: null,
        updated_at: nowIso,
      },
      { onConflict: 'project_id' },
    );
    if (error) {
      if (isMissing(error)) return 'missing';
      void logWarn('he.eng_auto_launch.intent_write_failed', errText('he_eng_launch_intent upsert', error), {
        projectId: args.projectId,
      });
      return 'error';
    }
  } catch (e) {
    void logWarn('he.eng_auto_launch.intent_write_failed', e instanceof Error ? e.message : 'unknown', {
      projectId: args.projectId,
    });
    return 'error';
  }
  try {
    const revived = {
      state: 'waiting',
      code: null,
      retries: 0,
      paid_failures: 0,
      start_retries: 0,
      next_at: nowIso,
      lease_until: null,
      updated_at: nowIso,
    };
    const [failedRes, cancelledRes, heldRes] = await Promise.all([
      db.from(HE_ENG_AUTO_LAUNCH_TABLE).update(revived).eq('project_id', args.projectId).eq('state', 'failed'),
      db
        .from(HE_ENG_AUTO_LAUNCH_TABLE)
        .update(revived)
        .eq('project_id', args.projectId)
        .eq('state', 'done')
        .eq('code', 'cancelled'),
      db
        .from(HE_ENG_AUTO_LAUNCH_TABLE)
        .update({ next_at: nowIso, updated_at: nowIso })
        .eq('project_id', args.projectId)
        .eq('state', 'held'),
    ]);
    for (const res of [failedRes, cancelledRes, heldRes]) {
      if (res.error && !isMissing(res.error)) {
        void logWarn('he.eng_auto_launch.rows_reset_failed', errText('he_eng_auto_launch reset', res.error), {
          projectId: args.projectId,
        });
      }
    }
  } catch (e) {
    void logWarn('he.eng_auto_launch.rows_reset_failed', e instanceof Error ? e.message : 'unknown', {
      projectId: args.projectId,
    });
  }
  return 'ok';
}

/**
 * Новое окно отправки для будущих ПЕРВЫХ запусков рынков проекта. Рынок с
 * записью о запуске держит своё окно (engClientLaunch.heEngLaunchWindowPlan);
 * его часы меняет PATCH .../schedule шаблона.
 */
export async function updateHeEngLaunchSchedule(
  db: SupabaseClient,
  args: { projectId: string; userId: string; schedule: ClientLaunchScheduleOverride },
): Promise<'ok' | 'no_intent' | 'missing' | 'error'> {
  try {
    const { data, error } = await db
      .from(HE_ENG_LAUNCH_INTENT_TABLE)
      .update({ schedule: toClientEngSendingWindow(args.schedule), updated_at: new Date().toISOString() })
      .eq('project_id', args.projectId)
      .eq('user_id', args.userId)
      .select('project_id');
    if (error) return isMissing(error) ? 'missing' : 'error';
    return (data ?? []).length > 0 ? 'ok' : 'no_intent';
  } catch {
    return 'error';
  }
}

/** «Cancel all jobs»: автозапуск проекта выключен (до следующего «Launch»). */
export async function cancelHeEngLaunchIntent(
  db: SupabaseClient,
  projectId: string,
  now?: Date,
): Promise<'ok' | 'no_intent' | 'missing' | 'error'> {
  const nowIso = (now ?? new Date()).toISOString();
  try {
    const { data, error } = await db
      .from(HE_ENG_LAUNCH_INTENT_TABLE)
      .update({ wanted: false, cancelled_at: nowIso, updated_at: nowIso })
      .eq('project_id', projectId)
      .select('project_id');
    if (error) return isMissing(error) ? 'missing' : 'error';
    return (data ?? []).length > 0 ? 'ok' : 'no_intent';
  } catch {
    return 'error';
  }
}

/* ─────────────── Кандидаты ─────────────── */

/** Шаблон, как его видит правило кандидатов (из полной строки или из выборки-отметки). */
interface TemplateView {
  id: string;
  verticalId: string;
  status: string;
  createdAt: string;
  /** Запись о запуске есть (кампания создана). */
  launched: boolean;
  /** Запуск не закончен (pending). */
  incomplete: boolean;
  /** Попытка запуска держит запись прямо сейчас. */
  leaseLive: boolean;
}

/**
 * Колонки шаблона для тика: запись о запуске не читается целиком (у
 * незаконченного в ней адреса долга) — только id кампании, аренда и стадия
 * первого долга (есть — запуск не закончен).
 */
const TEMPLATE_MARK_COLUMNS =
  'id, vertical_id, status, created_at, launch_campaign_id:launch_info->>campaign_id, ' +
  'launch_running_until:launch_info->>running_until, launch_pending_stage:launch_info->pending->0->>stage';

function templateViewOf(row: Record<string, unknown>, nowMs: number): TemplateView | null {
  const id = str(row.id);
  const verticalId = str(row.vertical_id);
  if (!id || !verticalId) return null;
  let launched: boolean;
  let incomplete: boolean;
  let leaseUntil: number | null;
  if ('launch_info' in row) {
    const info = parseLaunchInfo(row.launch_info);
    launched = info !== null;
    incomplete = heLaunchIsIncomplete(info);
    leaseUntil = readHeLaunchLease(row.launch_info).runningUntilMs;
  } else {
    launched = str(row.launch_campaign_id).length > 0;
    incomplete = launched && str(row.launch_pending_stage).length > 0;
    const until = tsOf(row.launch_running_until);
    leaseUntil = until > 0 ? until : null;
  }
  return {
    id,
    verticalId,
    status: str(row.status),
    createdAt: str(row.created_at),
    launched,
    incomplete,
    leaseLive: leaseUntil !== null && leaseUntil > nowMs,
  };
}

export interface HeEngAutoLaunchCandidate {
  templateId: string;
  verticalId: string;
  /** created_at шаблона — порядок «старые первыми» и дата синтетической строки. */
  createdAt: string;
}

/**
 * Какой шаблон каждой ВЫБРАННОЙ вертикали (есть accepted-гипотеза — тот же
 * предикат, что у реконсилера и дашборда) запускать автоматически:
 *  - у вертикали есть законченный запуск — ничего (один запуск на вертикаль);
 *  - у вертикали идёт попытка запуска (живая аренда записи) — ничего сейчас;
 *  - есть незаконченный запуск — его шаблон (повтор достраивает ровно долг);
 *  - иначе самый свежий 'ready' шаблон без записи о запуске.
 * Чистая функция: одно правило у тика и у деталки проекта.
 */
export function heEngAutoLaunchCandidates(input: {
  verticals: ReadonlyArray<Record<string, unknown>>;
  hypotheses: ReadonlyArray<Record<string, unknown>>;
  templates: ReadonlyArray<Record<string, unknown>>;
  nowMs?: number;
}): HeEngAutoLaunchCandidate[] {
  const nowMs = input.nowMs ?? Date.now();
  const selected = new Set<string>();
  for (const h of input.hypotheses) {
    if (h.status === 'accepted' && str(h.vertical_id)) selected.add(str(h.vertical_id));
  }
  const views = input.templates
    .map((t) => templateViewOf(t, nowMs))
    .filter((v): v is TemplateView => v !== null);
  const out: HeEngAutoLaunchCandidate[] = [];
  for (const vertical of input.verticals) {
    const verticalId = str(vertical.id);
    if (!verticalId || !selected.has(verticalId)) continue;
    const mine = views.filter((v) => v.verticalId === verticalId);
    if (mine.some((v) => v.launched && !v.incomplete)) continue;
    if (mine.some((v) => v.leaseLive)) continue;
    const unfinished = mine.find((v) => v.launched && v.incomplete);
    const pick =
      unfinished ??
      mine
        .filter((v) => v.status === 'ready' && !v.launched)
        .sort((a, b) => tsOf(b.createdAt) - tsOf(a.createdAt))[0];
    if (pick) out.push({ templateId: pick.id, verticalId, createdAt: pick.createdAt });
  }
  return out;
}

/* ─────────────── Решение по итогу ─────────────── */

/**
 * Итог одной попытки: запуска (общий вызов), повтора старта или проверки до
 * них. `start` у проверок — попытка была только стартом (законченный запуск):
 * её временный сбой повторяется как старт ('start_retry'), а не как запуск —
 * строку над законченным запуском берёт только режим старта.
 */
export type HeEngAutoLaunchOutcome =
  | HeEngLaunchSummary
  | { kind: 'start_retry'; verdict: HeEngLaunchSendingVerdict }
  /** requireEngMarket / loadClientHeTemplate отказали (статус их отказа). */
  | { kind: 'scope'; status: number; start?: boolean }
  /** Аккаунт до запуска (readHeEngAccountStanding): заблокирован или не прочитался. */
  | { kind: 'account'; standing: 'blocked' | 'unavailable'; start?: boolean }
  /** Брошенные попытки исчерпаны (heEngAbandonedMark.giveUp) — без новой попытки. */
  | { kind: 'abandoned'; start: boolean }
  /**
   * Строка брошена над законченным запуском, а решения «стартуем» на ней нет —
   * ничего не стартуем.
   */
  | { kind: 'start_undecided' };

export type HeEngAutoLaunchNoticeKind = 'sending_waiting' | 'sending_started' | 'action_needed';
export type HeEngAutoLaunchNoticeCode = 'letters_need_rewrite' | 'start_failed' | 'needs_support';

/** Письмо клиенту — контракт engClientMail.sendHeEngClientNotice. */
export interface HeEngAutoLaunchNotice {
  kind: HeEngAutoLaunchNoticeKind;
  projectId: string;
  templateId?: string | null;
  code?: HeEngAutoLaunchNoticeCode | null;
  refId?: string | null;
}

export interface HeEngAutoLaunchDecision {
  state: HeEngAutoLaunchState;
  code: HeEngAutoLaunchCode | null;
  /** Когда строку можно брать снова (ISO). */
  nextAt: string;
  retries: number;
  paidFailures: number;
  startRetries: number;
  /**
   * Письма клиенту (без projectId/templateId — их добавляет тик). У
   * needs_support `refId` — класс итога ('unfinished', 'failed', 'refused',
   * 'not_started', 'spend_limit', 'sending_turned_off'): ключ письма с ним, и
   * письмо одного класса не глушит позднее письмо другого.
   */
  notices: Array<{ kind: HeEngAutoLaunchNoticeKind; code?: HeEngAutoLaunchNoticeCode; refId?: string }>;
  /** Встало насовсем — алерт команде auto_launch_stuck. */
  alert: boolean;
  /**
   * Код алерта, если он не `code` строки: 'unfinished' (сдавшийся
   * незаконченный запуск), 'scope_refused' (отказ проверки рынка/шаблона).
   */
  alertCode?: string;
  /** Короткая метка итога для лога. */
  outcome: string;
}

const MINUTE = 60_000;
/** Сбой на нашей стороне до платной части: откат 2/10/30/60/120/240 мин, дальше 'failed'. */
const SERVER_ERROR_BACKOFF_MIN = [2, 10, 30, 60, 120, 240];
/** Запуск упал после платной части: +20, +60 мин; третий — 'failed'. */
const PAID_FAILURE_BACKOFF_MIN = [20, 60];
export const HE_ENG_AUTO_LAUNCH_PAID_FAILURES_MAX = 3;
/** Повтор одного старта: +10, +60 мин; дальше 'done' start_failed. */
const START_RETRY_BACKOFF_MIN = [10, 60];
const START_RETRIES_MAX = 2;
/** Незаконченный запуск: достройка каждые 30 мин, не больше трёх попыток подряд. */
const UNFINISHED_RETRY_MIN = 30;
const UNFINISHED_TRIES_MAX = 3;
/** Брошенная попытка запуска: вторая подряд — 'failed' без новой попытки. */
export const HE_ENG_AUTO_LAUNCH_ABANDONED_MAX = 2;
/** Заблокированный аккаунт: перепроверка раз в час. */
const ACCOUNT_BLOCKED_RECHECK_MIN = 60;

/**
 * Что делать со строкой по итогу попытки (чистая функция, `now` — часы
 * вызывающего). Таблица — в отчёте лейна S3 (§2.7); главное:
 *  - запущено и отправляет → done; письмо «Sending has started»;
 *  - пауза клиента → done client_paused (запуск паузу не снимает);
 *  - старт не удался временно → waiting start_retry (2 повтора), дальше done
 *    start_failed + письмо «нажмите Start sending»;
 *  - запуск не закончен → waiting unfinished (каждые 30 мин, 3 раза), дальше
 *    done needs_support + письмо + алерт;
 *  - аккаунт заблокирован (до запуска или перед стартом) → held
 *    account_blocked, перепроверка раз в час, без письма; алерт — при входе в
 *    этот код;
 *  - гейты (почта, лимиты, выключатель, ящики) → held со своим кодом,
 *    перепроверка через 10–60 мин;
 *  - «Cancel all jobs» посреди попытки тика (heEngStartGate) → done
 *    cancelled, старт не делался, без письма и алерта;
 *  - письма не проходят гейт подстановок → held letters_need_rewrite
 *    (перепроверка раз в сутки; «Rewrite letters» даёт новый шаблон);
 *  - 4xx ядра без гейта и 4xx проверок скоупа → held needs_support (раз в
 *    час; у старта — done) + алерт только при ВХОДЕ в код (перепроверка его
 *    не повторяет, как у account_blocked);
 *  - сбой до платной части → waiting server_error с откатом, после шести —
 *    failed; после платной части — paid_failures, после трёх — failed;
 *  - брошенные попытки исчерпаны → failed abandoned (+ алерт) или, у старта,
 *    done start_failed; брошенная над законченным запуском без решения
 *    «стартуем» → done needs_support, ничего не стартовано.
 * Сбои проверок у попытки-старта (`start`) повторяются как старт.
 */
export function heEngAutoLaunchVerdict(
  outcome: HeEngAutoLaunchOutcome,
  row: Pick<HeEngAutoLaunchRow, 'code' | 'retries' | 'paid_failures' | 'start_retries'>,
  now: Date,
): HeEngAutoLaunchDecision {
  const at = (minutes: number): string => new Date(now.getTime() + minutes * MINUTE).toISOString();
  const keep = { retries: 0, paidFailures: row.paid_failures, startRetries: row.start_retries };
  const decide = (
    state: HeEngAutoLaunchState,
    code: HeEngAutoLaunchCode | null,
    minutes: number,
    label: string,
    extra: Partial<Omit<HeEngAutoLaunchDecision, 'state' | 'code' | 'nextAt' | 'outcome'>> = {},
  ): HeEngAutoLaunchDecision => ({
    state,
    code,
    nextAt: at(minutes),
    ...keep,
    notices: [],
    alert: false,
    outcome: label,
    ...extra,
  });
  /** Письмо «нужно действие» с классом итога в ключе (см. notices). */
  const needsSupport = (refId: string) => ({ kind: 'action_needed' as const, code: 'needs_support' as const, refId });

  const startRetryOrGiveUp = (label: string): HeEngAutoLaunchDecision => {
    if (row.start_retries >= START_RETRIES_MAX) {
      return decide('done', 'start_failed', 0, `${label}:start_failed`, {
        notices: [{ kind: 'action_needed', code: 'start_failed' }],
      });
    }
    return decide('waiting', 'start_retry', START_RETRY_BACKOFF_MIN[row.start_retries] ?? 60, `${label}:start_retry`, {
      startRetries: row.start_retries + 1,
    });
  };

  const serverError = (label: string): HeEngAutoLaunchDecision => {
    const tries = row.code === 'server_error' ? row.retries + 1 : 1;
    if (tries > SERVER_ERROR_BACKOFF_MIN.length) {
      return decide('failed', 'server_error', 0, `${label}:failed`, { notices: [needsSupport('failed')], alert: true });
    }
    return decide('waiting', 'server_error', SERVER_ERROR_BACKOFF_MIN[tries - 1], label, { retries: tries });
  };

  // Заблокированный аккаунт войти не может — письма нет. Алерт — только при
  // входе в код: перепроверка раз в час его не повторяет.
  const accountBlocked = (label: string): HeEngAutoLaunchDecision =>
    decide('held', 'account_blocked', ACCOUNT_BLOCKED_RECHECK_MIN, label, { alert: row.code !== 'account_blocked' });

  switch (outcome.kind) {
    case 'launched': {
      const sending = outcome.sending;
      if (sending.kind === 'not_started' && sending.code === 'account_blocked') {
        return accountBlocked('launched_account_blocked');
      }
      // «Cancel all jobs» посреди попытки: старт не делался (и у незаконченного
      // запуска достройка не повторяется) — до нового «Launch».
      if (sending.kind === 'not_started' && sending.code === HE_ENG_START_CANCELLED_CODE) {
        return decide('done', 'cancelled', 0, 'launched_cancelled');
      }
      const startedNotice = sending.kind === 'started' ? [{ kind: 'sending_started' as const }] : [];
      if (!outcome.complete) {
        const tries = row.code === 'unfinished' ? row.retries + 1 : 1;
        if (tries >= UNFINISHED_TRIES_MAX) {
          return decide('done', 'needs_support', 0, 'launched_unfinished:give_up', {
            notices: [...startedNotice, needsSupport('unfinished')],
            alert: true,
            alertCode: 'unfinished',
          });
        }
        return decide('waiting', 'unfinished', UNFINISHED_RETRY_MIN, 'launched_unfinished', {
          retries: tries,
          notices: startedNotice,
        });
      }
      if (sending.kind === 'started') {
        return decide('done', null, 0, 'launched_sending', { notices: startedNotice });
      }
      switch (sending.reason) {
        case 'client_paused':
          return decide('done', 'client_paused', 0, 'launched_client_paused');
        case 'launch_problem':
        case 'window_not_applied':
        case 'not_requested':
          return decide('done', 'needs_support', 0, `launched_${sending.reason}`, {
            notices: [needsSupport('not_started')],
          });
        default:
          if (sending.retryable) return startRetryOrGiveUp(`launched_${sending.reason}`);
          return decide('done', 'needs_support', 0, `launched_${sending.reason}`, {
            notices: [needsSupport('not_started')],
          });
      }
    }
    case 'start_retry': {
      const v = outcome.verdict;
      if (v.kind === 'started') {
        return decide('done', null, 0, 'start_retry_sending', { notices: [{ kind: 'sending_started' }] });
      }
      if (v.code === 'account_blocked') return accountBlocked('start_retry_account_blocked');
      if (v.code === HE_ENG_START_CANCELLED_CODE) return decide('done', 'cancelled', 0, 'start_retry_cancelled');
      if (v.reason === 'client_paused') return decide('done', 'client_paused', 0, 'start_retry_client_paused');
      if (!v.retryable) {
        return decide('done', 'start_failed', 0, `start_retry_${v.reason}:start_failed`, {
          notices: [{ kind: 'action_needed', code: 'start_failed' }],
        });
      }
      return startRetryOrGiveUp(`start_retry_${v.reason}`);
    }
    case 'already_launched':
      return decide('done', null, 0, 'already_launched');
    case 'scope':
      if (outcome.status >= 500) {
        return outcome.start ? startRetryOrGiveUp('scope_unavailable') : serverError('scope_unavailable');
      }
      // Строку над законченным запуском берёт только режим старта, и 'held'
      // она бы не покинула — поэтому у старта 'done'. Алерт — при входе в код:
      // перепроверка раз в час его не повторяет.
      return decide(outcome.start ? 'done' : 'held', 'needs_support', 60, `scope_${outcome.status}`, {
        notices: [needsSupport('refused')],
        alert: row.code !== 'needs_support',
        alertCode: 'scope_refused',
      });
    case 'account':
      if (outcome.standing === 'blocked') return accountBlocked('account_blocked');
      return outcome.start ? startRetryOrGiveUp('account_unavailable') : serverError('account_unavailable');
    case 'abandoned':
      if (outcome.start) {
        return decide('done', 'start_failed', 0, 'abandoned_start:start_failed', {
          notices: [{ kind: 'action_needed', code: 'start_failed' }],
        });
      }
      return decide('failed', 'abandoned', 0, 'abandoned:failed', {
        retries: row.retries,
        notices: [needsSupport('failed')],
        alert: true,
      });
    case 'start_undecided':
      return decide('done', 'needs_support', 0, 'start_undecided', { notices: [needsSupport('not_started')] });
    case 'failed': {
      if (outcome.paid) {
        const paidFailures = row.paid_failures + 1;
        if (paidFailures >= HE_ENG_AUTO_LAUNCH_PAID_FAILURES_MAX) {
          return decide('failed', 'launch_failed', 0, 'failed_paid:failed', {
            paidFailures,
            notices: [needsSupport('failed')],
            alert: true,
          });
        }
        return decide('waiting', 'launch_failed', PAID_FAILURE_BACKOFF_MIN[paidFailures - 1] ?? 60, 'failed_paid', {
          paidFailures,
        });
      }
      return serverError('failed_unpaid');
    }
    case 'refused': {
      const code = outcome.code;
      switch (code) {
        case 'email_not_verified':
        case 'spend_day_limit':
        case 'unavailable':
          return decide('held', code, 10, `refused_${code}`);
        case 'spend_limit':
          return decide('held', 'spend_limit', 60, 'refused_spend_limit', {
            notices: [needsSupport('spend_limit')],
          });
        case 'sending_not_enabled':
          return decide('held', 'sending_not_enabled', 10, 'refused_sending_not_enabled', {
            notices: [{ kind: 'sending_waiting' }],
          });
        case 'sending_turned_off':
          return decide('held', 'sending_turned_off', 60, 'refused_sending_turned_off', {
            notices: [needsSupport('sending_turned_off')],
          });
        case 'sending_mailboxes_shortage':
          return decide('held', 'mailboxes_short', 10, 'refused_mailboxes_short');
        case 'sending_setup_unavailable':
        case 'sending_setup_failed':
        case 'sending_access_unavailable':
          return decide('held', 'setup_unavailable', 10, `refused_${code}`);
        case 'retry_limited':
          return {
            ...decide('waiting', 'retry_limited', 0, 'refused_retry_limited'),
            nextAt: new Date(now.getTime() + Math.max(60, outcome.retryAfterSeconds ?? 60) * 1000).toISOString(),
          };
        case 'research_running':
          return decide('held', 'research_running', 10, 'refused_research_running');
        case 'launch_running':
          return decide('waiting', 'launch_running', 5, 'refused_launch_running');
        case 'template_unresolved_operators':
          return decide('held', 'letters_need_rewrite', 24 * 60, 'refused_letters', {
            notices: [{ kind: 'action_needed', code: 'letters_need_rewrite' }],
          });
        case 'template_not_ready':
          // Шаблон перестал быть готовым (письма переписываются): правило
          // кандидатов его больше не выберет, строка просто ждёт.
          return decide('waiting', null, 10, 'refused_template_not_ready');
        default:
          // Алерт — при входе в код (перепроверка раз в час его не повторяет).
          return decide('held', 'needs_support', 60, `refused_${code ?? outcome.status}`, {
            notices: [needsSupport('refused')],
            alert: row.code !== 'needs_support',
          });
      }
    }
  }
}

/* ─────────────── Взять строку и записать решение ─────────────── */

export type HeEngAutoLaunchClaim =
  | { kind: 'claimed'; row: HeEngAutoLaunchRow }
  /** Строку держит другой (тик или кнопка) либо ей ещё не пора. */
  | { kind: 'busy' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/**
 * Взять строку шаблона (he_eng_auto_launch_claim). `manual` — кнопка
 * «Launch now»: берёт любую строку, кроме взятой другим с живой арендой.
 */
export async function claimHeEngAutoLaunch(
  db: SupabaseClient,
  args: { templateId: string; projectId: string; manual: boolean; leaseSeconds?: number },
): Promise<HeEngAutoLaunchClaim> {
  try {
    const { data, error } = await db.rpc(HE_ENG_AUTO_LAUNCH_CLAIM_RPC, {
      p_template_id: args.templateId,
      p_project_id: args.projectId,
      p_lease_seconds: args.leaseSeconds ?? HE_ENG_AUTO_LAUNCH_LEASE_SECONDS,
      p_manual: args.manual,
    });
    if (error) {
      if (isMissing(error)) return { kind: 'missing' };
      return { kind: 'error', message: errText('he_eng_auto_launch_claim', error) };
    }
    const row = toRow(Array.isArray(data) ? data[0] : data);
    return row ? { kind: 'claimed', row } : { kind: 'busy' };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}

/**
 * Записать решение во взятую строку. Условие — строка всё ещё взята ЭТОЙ
 * попыткой (state 'running' и тот же attempts): если аренда истекла и строку
 * взял другой, его запись не затирается ('lost').
 */
export async function recordHeEngAutoLaunchDecision(
  db: SupabaseClient,
  claimed: HeEngAutoLaunchRow,
  decision: HeEngAutoLaunchDecision,
): Promise<'ok' | 'lost' | 'error'> {
  try {
    const { data, error } = await db
      .from(HE_ENG_AUTO_LAUNCH_TABLE)
      .update({
        state: decision.state,
        code: decision.code,
        retries: decision.retries,
        paid_failures: decision.paidFailures,
        start_retries: decision.startRetries,
        next_at: decision.nextAt,
        lease_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq('template_id', claimed.template_id)
      .eq('state', 'running')
      .eq('attempts', claimed.attempts)
      .select('template_id');
    if (error) {
      void logWarn('he.eng_auto_launch.record_failed', errText('he_eng_auto_launch update', error), {
        templateId: claimed.template_id,
      });
      return 'error';
    }
    return (data ?? []).length > 0 ? 'ok' : 'lost';
  } catch (e) {
    void logWarn('he.eng_auto_launch.record_failed', e instanceof Error ? e.message : 'unknown', {
      templateId: claimed.template_id,
    });
    return 'error';
  }
}

/**
 * Пометка во взятой строке, пока попытка идёт (строка остаётся 'running'):
 * решение «стартуем» (code 'start_pending') или брошенная прошлая попытка
 * (счётчики). Условие — то же, что у записи решения: строка всё ещё взята
 * ЭТОЙ попыткой (state 'running' и тот же attempts), чужое взятие не
 * трогается ('lost').
 */
export async function recordHeEngAutoLaunchMark(
  db: SupabaseClient,
  claimed: HeEngAutoLaunchRow,
  mark: Partial<Pick<HeEngAutoLaunchRow, 'code' | 'retries' | 'paid_failures' | 'start_retries'>>,
): Promise<'ok' | 'lost' | 'error'> {
  try {
    const { data, error } = await db
      .from(HE_ENG_AUTO_LAUNCH_TABLE)
      .update({ ...mark, updated_at: new Date().toISOString() })
      .eq('template_id', claimed.template_id)
      .eq('state', 'running')
      .eq('attempts', claimed.attempts)
      .select('template_id');
    if (error) {
      void logWarn('he.eng_auto_launch.mark_failed', errText('he_eng_auto_launch mark', error), {
        templateId: claimed.template_id,
      });
      return 'error';
    }
    return (data ?? []).length > 0 ? 'ok' : 'lost';
  } catch (e) {
    void logWarn('he.eng_auto_launch.mark_failed', e instanceof Error ? e.message : 'unknown', {
      templateId: claimed.template_id,
    });
    return 'error';
  }
}

/**
 * Взятие строки, брошенной прошлой попыткой: в снимке тика строка 'running'
 * (аренда истекла — иначе тик её не взял бы), и между снимком и взятием её
 * никто не трогал — взятий не было (attempts + 1) и решение не писалось
 * (next_at прежний: его меняет каждое решение и каждое «Launch», а взятие,
 * продление аренды и пометки — нет). null — взятие не брошенной строки.
 *
 * Запуск (`start` false): брошенная попытка могла оплатить классификатор —
 * paid_failures + 1, код 'abandoned', retries — сколько брошено подряд;
 * giveUp — подряд HE_ENG_AUTO_LAUNCH_ABANDONED_MAX или paid_failures дошли до
 * предела: дальше не запускаем. Старт (`start` true): неоплачиваемый повтор
 * старта — start_retries + 1, код не меняется (он и есть решение «стартуем»);
 * giveUp — повторы старта исчерпаны.
 */
export function heEngAbandonedMark(
  snapshot: HeEngAutoLaunchRow | null,
  claimed: HeEngAutoLaunchRow,
  start: boolean,
): { giveUp: boolean; mark: Partial<HeEngAutoLaunchRow>; row: HeEngAutoLaunchRow } | null {
  if (!snapshot || snapshot.state !== 'running') return null;
  if (claimed.attempts !== snapshot.attempts + 1 || tsOf(claimed.next_at) !== tsOf(snapshot.next_at)) return null;
  if (start) {
    const startRetries = claimed.start_retries + 1;
    return {
      giveUp: startRetries > START_RETRIES_MAX,
      mark: { start_retries: startRetries },
      row: { ...claimed, start_retries: startRetries },
    };
  }
  const retries = (snapshot.code === 'abandoned' ? snapshot.retries : 0) + 1;
  const paidFailures = claimed.paid_failures + 1;
  return {
    giveUp: retries >= HE_ENG_AUTO_LAUNCH_ABANDONED_MAX || paidFailures >= HE_ENG_AUTO_LAUNCH_PAID_FAILURES_MAX,
    mark: { code: 'abandoned', retries, paid_failures: paidFailures },
    row: { ...claimed, code: 'abandoned', retries, paid_failures: paidFailures },
  };
}

/* ─────────────── Аккаунт и проверка перед стартом ─────────────── */

/**
 * Может ли аккаунт сейчас запускать и стартовать — та часть requireClientAuth
 * (clientApiHelper.ts), что не про сессию, для вызова без запроса (тик
 * воркера) и для перепроверки посреди запуска:
 *  - бан Supabase (auth.users.banned_until в будущем; блокировка в
 *    /admin/users ставит его и отзывает сессии) — 'blocked' ('banned');
 *  - профиль: role 'client' или 'admin' (иначе requireClientAuth отвечает
 *    403), не is_demo (демо-аккаунт read-only) — 'blocked' ('role' / 'demo');
 *  - пользователя или профиля нет — 'blocked' ('missing' / 'role').
 * Любой сбой чтения — 'unavailable' (fail-closed: не разрешает ничего), если
 * второе чтение не дало блокировку само. НЕ БРОСАЕТ.
 */
export type HeEngAccountStanding =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: 'banned' | 'role' | 'demo' | 'missing' }
  | { kind: 'unavailable'; message: string };

export async function readHeEngAccountStanding(db: SupabaseClient, userId: string): Promise<HeEngAccountStanding> {
  try {
    const [userRes, profileRes] = await Promise.all([
      db.auth.admin.getUserById(userId),
      db.from('profiles').select('role, is_demo').eq('id', userId).maybeSingle(),
    ]);
    let unavailable: string | null = null;
    if (profileRes.error) {
      unavailable = errText('profiles read', profileRes.error);
    } else {
      const profile = (profileRes.data ?? null) as { role?: unknown; is_demo?: unknown } | null;
      if (profile?.role !== 'client' && profile?.role !== 'admin') return { kind: 'blocked', reason: 'role' };
      if (profile.is_demo === true) return { kind: 'blocked', reason: 'demo' };
    }
    if (userRes.error) {
      const authErr = userRes.error as { status?: number; code?: string; message?: string };
      if (authErr.status === 404 || authErr.code === 'user_not_found') return { kind: 'blocked', reason: 'missing' };
      return { kind: 'unavailable', message: unavailable ?? `auth user read: ${String(authErr.message ?? '').slice(0, 200)}` };
    }
    const user = userRes.data?.user ?? null;
    if (!user) return { kind: 'blocked', reason: 'missing' };
    const bannedUntil = typeof user.banned_until === 'string' ? user.banned_until.trim() : '';
    if (bannedUntil) {
      // Непарсящийся срок бана — считаем баном (fail-closed).
      const until = Date.parse(bannedUntil);
      if (!Number.isFinite(until) || until > Date.now()) return { kind: 'blocked', reason: 'banned' };
    }
    return unavailable ? { kind: 'unavailable', message: unavailable } : { kind: 'ok' };
  } catch (e) {
    return { kind: 'unavailable', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}

/** Аккаунт заблокирован посреди запуска: старт не начат (`sending.refusal` ответа кнопки). */
export const ENG_ACCOUNT_NOT_ACTIVE_TEXT = 'Your account is not active.';
/** Аккаунт не прочитался перед стартом: старт не начат, кампании созданы. */
export const ENG_ACCOUNT_UNREAD_TEXT =
  'We could not check your account just now. The sending status of this market shows how to start the campaigns.';

/** Код отказа проверки перед стартом: автозапуск проекта отменён посреди попытки тика. */
const HE_ENG_START_CANCELLED_CODE = 'cancelled';
/** Автозапуск отменён посреди попытки тика (кнопка эту проверку не проходит — текст только в журнал). */
const ENG_LAUNCH_CANCELLED_TEXT = 'Automatic launch was turned off for this project, so sending was not started.';

/**
 * Автозапуск проекта всё ещё действует (перечитывается перед стартом попытки
 * тика): намерение wanted, автопилот проекта включён, отметка отмены
 * (he_projects.cancelled_at) не новее последнего «Launch». «Cancel all jobs»
 * пишет и то и другое (api/client/eng/projects/[id]/cancel). Сбой чтения
 * (и нет таблицы намерения) — 'unavailable'. НЕ БРОСАЕТ.
 */
async function readHeEngLaunchStillWanted(
  db: SupabaseClient,
  projectId: string,
): Promise<{ kind: 'wanted' } | { kind: 'cancelled'; reason: string } | { kind: 'unavailable'; message: string }> {
  try {
    const intentRead = await readHeEngLaunchIntent(db, projectId);
    if (intentRead.kind === 'error') return { kind: 'unavailable', message: intentRead.message };
    if (intentRead.kind === 'missing') return { kind: 'unavailable', message: 'he_eng_launch_intent missing' };
    const intent = intentRead.intent;
    if (!intent || !intent.wanted) return { kind: 'cancelled', reason: 'intent_off' };
    let projectRes = await db
      .from('he_projects')
      .select('id, autopilot, cancelled_at')
      .eq('id', projectId)
      .maybeSingle();
    // Колонки отметки отмены может не быть (20261009_0002) — как у тика.
    if (projectRes.error && isHeMissingColumnError(projectRes.error as { code?: string })) {
      projectRes = await db.from('he_projects').select('id, autopilot').eq('id', projectId).maybeSingle();
    }
    if (projectRes.error) return { kind: 'unavailable', message: errText('he_projects read', projectRes.error) };
    const project = (projectRes.data ?? null) as Record<string, unknown> | null;
    if (!project) return { kind: 'cancelled', reason: 'project_missing' };
    if (project.autopilot !== true) return { kind: 'cancelled', reason: 'autopilot_off' };
    const cancelledAt = tsOf(project.cancelled_at);
    if (cancelledAt > 0 && cancelledAt > tsOf(intent.requestedAt)) return { kind: 'cancelled', reason: 'cancelled_after_launch' };
    return { kind: 'wanted' };
  } catch (e) {
    return { kind: 'unavailable', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}

/**
 * Проверка прямо перед стартом кампаний (`onStartDecided` engClientLaunch) —
 * общая у кнопки «Launch now» и тика:
 *  1. аккаунт (readHeEngAccountStanding) — бан мог прийти посреди запуска;
 *  2. только у тика (`projectId` задан; запуск и повтор старта): автозапуск
 *     проекта всё ещё действует (readHeEngLaunchStillWanted) — «Cancel all
 *     jobs» мог прийти посреди попытки. Отменён — HE_ENG_START_CANCELLED_CODE
 *     (строка 'done cancelled', без письма); не прочиталось — повторяемый
 *     отказ. Кнопка — само нажатие клиента, её эта проверка не держит;
 *  3. решение «стартуем» записано во взятую строку автозапуска (code
 *     'start_pending', условие — строка всё ещё взята этой попыткой). Без
 *     этой записи брошенная после ядра строка не стартует ничего (режим
 *     старта тика её требует). Строки нет (`claimed` null: миграции нет) —
 *     записывать некуда, и тика нет.
 * Любой отказ и сбой — старт не начат (fail-closed).
 */
export function heEngStartGate(
  db: SupabaseClient,
  args: { userId: string; templateId: string; claimed: HeEngAutoLaunchRow | null; projectId?: string },
): () => Promise<HeEngStartGateResult> {
  return async () => {
    const standing = await readHeEngAccountStanding(db, args.userId);
    if (standing.kind === 'blocked') {
      void logWarn('he.eng_auto_launch.start_account_blocked', `start refused: account ${standing.reason}`, {
        userId: args.userId,
        templateId: args.templateId,
      });
      return { ok: false, code: 'account_blocked', message: ENG_ACCOUNT_NOT_ACTIVE_TEXT, retryable: false };
    }
    if (standing.kind === 'unavailable') {
      void logWarn('he.eng_auto_launch.start_account_unread', standing.message, {
        userId: args.userId,
        templateId: args.templateId,
      });
      return { ok: false, code: 'account_unavailable', message: ENG_ACCOUNT_UNREAD_TEXT, retryable: true };
    }
    if (args.projectId) {
      const still = await readHeEngLaunchStillWanted(db, args.projectId);
      if (still.kind === 'cancelled') {
        void logWarn('he.eng_auto_launch.start_cancelled', `start refused: ${still.reason}`, {
          userId: args.userId,
          projectId: args.projectId,
          templateId: args.templateId,
        });
        return { ok: false, code: HE_ENG_START_CANCELLED_CODE, message: ENG_LAUNCH_CANCELLED_TEXT, retryable: false };
      }
      if (still.kind === 'unavailable') {
        void logWarn('he.eng_auto_launch.start_intent_unread', still.message, {
          userId: args.userId,
          projectId: args.projectId,
          templateId: args.templateId,
        });
        return { ok: false, code: 'launch_state_unavailable', message: ENG_START_GATE_FAILED_TEXT, retryable: true };
      }
    }
    if (args.claimed) {
      const marked = await recordHeEngAutoLaunchMark(db, args.claimed, { code: 'start_pending' });
      if (marked !== 'ok') {
        void logWarn('he.eng_auto_launch.start_not_recorded', `start decision not recorded: ${marked}`, {
          userId: args.userId,
          templateId: args.templateId,
        });
        return { ok: false, code: 'start_not_recorded', message: ENG_START_GATE_FAILED_TEXT, retryable: true };
      }
    }
    return { ok: true };
  };
}

/**
 * Продлевать аренду взятой строки, пока идёт запуск, — и тику, и кнопке
 * «Launch now». Общего срока у запуска нет ни в воркере, ни у кнопки
 * (standalone-сервер Next maxDuration роута не обрывает): классификатор
 * сегментов с повторами модели может идти дольше
 * HE_ENG_AUTO_LAUNCH_LEASE_SECONDS, а до первой записи ядра (после первой
 * кампании) своей аренды у запуска нет — истёкшая аренда строки пустила бы
 * второй запуск того же шаблона (тик или «Launch now»). Продление — каждые две
 * минуты, только пока строка всё ещё взята этой попыткой (state 'running', тот
 * же attempts): чужое взятие не продлевается. Сбой продления — строка warn
 * (одна на процесс); запуск не прерывается. Возвращает «остановить» — звать в
 * finally.
 */
const LEASE_HEARTBEAT_MS = 2 * 60_000;

export function startHeEngAutoLaunchLeaseHeartbeat(db: SupabaseClient, claimed: HeEngAutoLaunchRow): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const { error } = await db
          .from(HE_ENG_AUTO_LAUNCH_TABLE)
          .update({
            lease_until: new Date(Date.now() + HE_ENG_AUTO_LAUNCH_LEASE_SECONDS * 1000).toISOString(),
          })
          .eq('template_id', claimed.template_id)
          .eq('state', 'running')
          .eq('attempts', claimed.attempts);
        if (error) warnOnce('lease_heartbeat_failed', errText('he_eng_auto_launch lease renew', error));
      } catch (e) {
        warnOnce('lease_heartbeat_failed', e instanceof Error ? e.message : 'unknown');
      }
    })();
  }, LEASE_HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/* ─────────────── Чтение для кабинета ─────────────── */

/**
 * Строка 'running', аренду которой никто не держит (истекла или её нет) —
 * то же условие, по которому её снова берёт тик (isDue) и замок кнопки.
 */
export function heEngAutoLaunchLeaseExpired(
  row: Pick<HeEngAutoLaunchRow, 'state' | 'lease_until'>,
  nowMs: number,
): boolean {
  return row.state === 'running' && (!row.lease_until || tsOf(row.lease_until) <= nowMs);
}

export interface EngAutoLaunchMarket {
  template_id: string;
  vertical_id: string;
  state: HeEngAutoLaunchState;
  code: HeEngAutoLaunchCode | null;
  next_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Только у 'running': аренда истекла — взявший (кнопка или тик) не
   * продлевает её, то есть попытка брошена (процесс умер). Строку снова
   * возьмёт тик проекта с включённым автозапуском или «Launch now» (замок
   * берёт 'running' с истёкшей арендой); без автозапуска её не возьмёт никто,
   * и кабинет показывает «Launch now» вместо вечного «Starting sending…».
   */
  stale?: boolean;
}

/**
 * Автозапуск проекта для деталки (GET api/client/eng/projects/[id]):
 *  - available — миграция есть (иначе «Launch now» у каждого готового рынка);
 *  - requested — намерение включено; requested_at / cancelled_at — даты;
 *  - markets — строки шаблонов проекта плюс СИНТЕТИЧЕСКИЕ 'waiting' для
 *    кандидатов без строки (только при включённом намерении; created_at —
 *    дата шаблона: от неё кабинет считает «дольше обычного»).
 * Строки — только шаблонов из деталки (удалённые шаблоны строк не имеют:
 * каскад). Счётчики и аренда кабинету не нужны и не отдаются.
 */
export interface EngAutoLaunchDetail {
  available: boolean;
  requested: boolean;
  requested_at: string | null;
  cancelled_at: string | null;
  markets: EngAutoLaunchMarket[];
}

/** null — не прочиталось (ключа в ответе нет, кабинет считает осторожно). */
export async function readHeEngAutoLaunchDetail(
  db: SupabaseClient,
  projectId: string,
  detail: {
    verticals?: ReadonlyArray<Record<string, unknown>>;
    hypotheses?: ReadonlyArray<Record<string, unknown>>;
    templates?: ReadonlyArray<Record<string, unknown>>;
  },
): Promise<EngAutoLaunchDetail | null> {
  const intentRead = await readHeEngLaunchIntent(db, projectId);
  if (intentRead.kind === 'missing') {
    return { available: false, requested: false, requested_at: null, cancelled_at: null, markets: [] };
  }
  if (intentRead.kind === 'error') return null;
  const intent = intentRead.intent;
  let rows: HeEngAutoLaunchRow[];
  try {
    const { data, error } = await db
      .from(HE_ENG_AUTO_LAUNCH_TABLE)
      .select(ROW_COLUMNS)
      .eq('project_id', projectId)
      .limit(500);
    if (error) {
      if (isMissing(error)) {
        return { available: false, requested: false, requested_at: null, cancelled_at: null, markets: [] };
      }
      return null;
    }
    rows = (data ?? []).map(toRow).filter((r): r is HeEngAutoLaunchRow => r !== null);
  } catch {
    return null;
  }
  const templates = detail.templates ?? [];
  const verticalOf = new Map(templates.map((t) => [str(t.id), str(t.vertical_id)]));
  const nowMs = Date.now();
  const markets: EngAutoLaunchMarket[] = rows
    .filter((r) => verticalOf.has(r.template_id))
    .map((r) => ({
      template_id: r.template_id,
      vertical_id: verticalOf.get(r.template_id) ?? '',
      state: r.state,
      code: r.code,
      next_at: r.next_at || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...(heEngAutoLaunchLeaseExpired(r, nowMs) ? { stale: true } : {}),
    }));
  if (intent?.wanted) {
    const withRow = new Set(rows.map((r) => r.template_id));
    for (const c of heEngAutoLaunchCandidates({
      verticals: detail.verticals ?? [],
      hypotheses: detail.hypotheses ?? [],
      templates,
    })) {
      if (withRow.has(c.templateId)) continue;
      markets.push({
        template_id: c.templateId,
        vertical_id: c.verticalId,
        state: 'waiting',
        code: null,
        next_at: null,
        created_at: c.createdAt,
        updated_at: c.createdAt,
      });
    }
  }
  return {
    available: true,
    requested: intent?.wanted === true,
    requested_at: intent?.requestedAt || null,
    cancelled_at: intent?.cancelledAt ?? null,
    markets,
  };
}

/**
 * Намерения и строки по проектам — для дашборда (одной пачкой). null — не
 * прочиталось или миграции нет (ключа автозапуска на карточках нет).
 */
export async function readHeEngAutoLaunchForProjects(
  db: SupabaseClient,
  projectIds: string[],
): Promise<{ wanted: Set<string>; rows: Map<string, HeEngAutoLaunchRow> } | null> {
  const wanted = new Set<string>();
  const rows = new Map<string, HeEngAutoLaunchRow>();
  if (projectIds.length === 0) return { wanted, rows };
  try {
    for (let i = 0; i < projectIds.length; i += ID_CHUNK) {
      const chunk = projectIds.slice(i, i + ID_CHUNK);
      const [intentsRes, rowsRes] = await Promise.all([
        db.from(HE_ENG_LAUNCH_INTENT_TABLE).select('project_id, wanted').in('project_id', chunk),
        db.from(HE_ENG_AUTO_LAUNCH_TABLE).select(ROW_COLUMNS).in('project_id', chunk).limit(1000),
      ]);
      if (intentsRes.error || rowsRes.error) return null;
      for (const r of (intentsRes.data ?? []) as Array<Record<string, unknown>>) {
        if (r.wanted === true && str(r.project_id)) wanted.add(str(r.project_id));
      }
      for (const raw of rowsRes.data ?? []) {
        const row = toRow(raw);
        if (row) rows.set(row.template_id, row);
      }
    }
  } catch {
    return null;
  }
  return { wanted, rows };
}

/* ─────────────── Тик воркера ─────────────── */

/**
 * Почтовый модуль кабинета (engClientMail): письмо по событию и проход по
 * накопившимся событиям. Подключается воркером; нет — писем нет (строка
 * автозапуска всё равно пишется, кабинет показывает состояние).
 */
export interface HeEngAutoLaunchMailer {
  send(db: SupabaseClient, notice: HeEngAutoLaunchNotice): Promise<unknown>;
  scan?(db: SupabaseClient, opts: { now?: Date }): Promise<unknown>;
}

export interface HeEngAutoLaunchTickOptions {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  now?: Date;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  shouldStop: () => boolean;
  mail?: HeEngAutoLaunchMailer | null;
  env?: NodeJS.ProcessEnv;
}

interface DueCandidate {
  projectId: string;
  templateId: string;
  verticalId: string;
  intent: HeEngLaunchIntent;
  row: HeEngAutoLaunchRow | null;
  /**
   * 'launch' — общий вызов запуска (кандидат heEngAutoLaunchCandidates);
   * 'start' — у шаблона уже ЗАКОНЧЕННЫЙ запуск, и старт кампаний решён, но не
   * сделан (retryHeEngLaunchStart): 'waiting start_retry', брошенная 'running'
   * с решением ('start_pending' / 'start_retry') или 'held account_blocked'
   * (аккаунт заблокировали перед стартом). Ядро второй раз не зовётся: оно
   * ответило бы «уже запущено», и старт потерялся бы;
   * 'undecided' — брошенная 'running' над законченным запуском БЕЗ решения
   * «стартуем»: старт не делается (обрыв мог прийти до пропуска старта),
   * строка — 'done needs_support'.
   */
  mode: 'launch' | 'start' | 'undecided';
  /** Порядок: next_at строки, у новой — дата шаблона. */
  orderMs: number;
}

/** Строке пора: нет её; 'waiting'/'held' с наступившим next_at; 'running' с истёкшей арендой. */
function isDue(row: HeEngAutoLaunchRow | null, nowMs: number): boolean {
  if (!row) return true;
  if (row.state === 'waiting' || row.state === 'held') return tsOf(row.next_at) <= nowMs;
  if (row.state === 'running') return !row.lease_until || tsOf(row.lease_until) <= nowMs;
  return false;
}

/** Проект, которому разрешён автозапуск (намерение действует и не отменено после). */
function projectQualifies(project: Record<string, unknown>, intent: HeEngLaunchIntent): boolean {
  if (project.autopilot !== true) return false;
  if (project.status !== 'researched') return false;
  if (project.market !== 'us') return false;
  if (str(project.created_by) !== intent.userId) return false;
  const cancelledAt = tsOf(project.cancelled_at);
  return !(cancelledAt > 0 && cancelledAt > tsOf(intent.requestedAt));
}

async function readChunked<T>(
  ids: string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown[] | null; error: PgError | null }>,
): Promise<{ rows: T[] } | { error: PgError }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const res = await read(ids.slice(i, i + ID_CHUNK));
    if (res.error) return { error: res.error };
    rows.push(...((res.data ?? []) as T[]));
  }
  return { rows };
}

/** Решение «стартуем» на строке над законченным запуском (см. DueCandidate.mode 'start'). */
function startDecided(row: HeEngAutoLaunchRow): boolean {
  if (row.state === 'waiting') return row.code === 'start_retry';
  if (row.state === 'running') return row.code === 'start_pending' || row.code === 'start_retry';
  if (row.state === 'held') return row.code === 'account_blocked';
  return false;
}

/**
 * Намерение проекта ИСПОЛНЕНО — тику по нему делать больше нечего, пока
 * клиент не нажмёт «Launch» снова: у КАЖДОЙ выбранной вертикали есть
 * законченный запуск (такая вертикаль кандидатом не бывает — один запуск на
 * вертикаль, — а «Rewrite letters» рынку с письмами в кампании отказывает), и
 * ни у одного законченного запуска нет строки, которую тик ещё берёт:
 * 'running' или с решённым, но не сделанным стартом (startDecided).
 * Вертикаль без законченного запуска — в том числе остановленная ('failed',
 * 'done needs_support') — намерение открытым оставляет: «Launch now» клиента
 * или новый шаблон рынка снова дают тику работу, а их тик видит, только пока
 * читает проект. Чистая функция.
 */
export function heEngLaunchSettled(input: {
  verticals: ReadonlyArray<Record<string, unknown>>;
  hypotheses: ReadonlyArray<Record<string, unknown>>;
  templates: ReadonlyArray<Record<string, unknown>>;
  rows: ReadonlyMap<string, HeEngAutoLaunchRow>;
  nowMs?: number;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  const selected = new Set<string>();
  for (const h of input.hypotheses) {
    if (h.status === 'accepted' && str(h.vertical_id)) selected.add(str(h.vertical_id));
  }
  const verticalIds = input.verticals.map((v) => str(v.id)).filter((id) => id && selected.has(id));
  if (verticalIds.length === 0) return false;
  const views = input.templates
    .map((t) => templateViewOf(t, nowMs))
    .filter((v): v is TemplateView => v !== null);
  for (const verticalId of verticalIds) {
    const finished = views.filter((v) => v.verticalId === verticalId && v.launched && !v.incomplete);
    if (finished.length === 0) return false;
    for (const view of finished) {
      const row = input.rows.get(view.id);
      if (row && (row.state === 'running' || startDecided(row))) return false;
    }
  }
  return true;
}

/**
 * Отметить намерение исполненным (heEngLaunchSettled): тик его больше не
 * читает, пока новое «Launch» (writeHeEngLaunchIntent) не снимет отметку.
 * Условие — то самое нажатие (requested_at прочитанного намерения) и
 * намерение не отменено: «Launch» или «Cancel all jobs» между чтением и
 * записью отметку не получают ('lost'). НЕ БРОСАЕТ.
 */
async function settleHeEngLaunchIntent(
  db: SupabaseClient,
  intent: HeEngLaunchIntent,
  nowIso: string,
): Promise<'ok' | 'lost' | 'error'> {
  try {
    const { data, error } = await db
      .from(HE_ENG_LAUNCH_INTENT_TABLE)
      .update({ settled_at: nowIso, updated_at: nowIso })
      .eq('project_id', intent.projectId)
      .eq('wanted', true)
      .eq('requested_at', intent.requestedAt)
      .is('settled_at', null)
      .select('project_id');
    if (error) return 'error';
    return (data ?? []).length > 0 ? 'ok' : 'lost';
  } catch {
    return 'error';
  }
}

/**
 * Курсор прохода по ОТКРЫТЫМ намерениям (wanted и не исполнены): project_id,
 * после которого начнёт следующий проход. В памяти процесса; после рестарта —
 * с начала.
 */
let openIntentCursor = '';

/**
 * Один проход по открытым намерениям: по порядку project_id от курсора до
 * конца, затем с начала до курсора включительно, страницами INTENT_PAGE и не
 * больше INTENTS_PER_PASS строк. Упёрся в бюджет (`budgetHit`) — следующий
 * проход продолжает после последней прочитанной строки (курсор вращается);
 * прочитал всех — следующий начинает с начала. Так каждое открытое намерение
 * читается хотя бы раз за ⌈N / INTENTS_PER_PASS⌉ проходов, сколько бы их ни
 * было, а исполненные (settled_at) не читаются вовсе.
 */
async function readOpenIntentsPass(
  db: SupabaseClient,
): Promise<{ intents: HeEngLaunchIntent[]; budgetHit: boolean } | { error: PgError }> {
  const start = openIntentCursor;
  const intents: HeEngLaunchIntent[] = [];
  const seen = new Set<string>();
  let read = 0;
  let last = '';
  for (const part of start ? (['after', 'wrap'] as const) : (['after'] as const)) {
    let after = part === 'after' ? start : '';
    for (;;) {
      const limit = Math.min(INTENT_PAGE, INTENTS_PER_PASS - read);
      if (limit <= 0) break;
      let query = db
        .from(HE_ENG_LAUNCH_INTENT_TABLE)
        .select(INTENT_COLUMNS)
        .eq('wanted', true)
        .is('settled_at', null);
      if (after) query = query.gt('project_id', after);
      if (part === 'wrap') query = query.lte('project_id', start);
      const { data, error } = await query.order('project_id', { ascending: true }).limit(limit);
      if (error) return { error };
      const page = (data ?? []) as Array<Record<string, unknown>>;
      read += page.length;
      for (const raw of page) {
        const intent = toIntent(raw);
        if (intent && !seen.has(intent.projectId)) {
          seen.add(intent.projectId);
          intents.push(intent);
        }
      }
      if (page.length > 0) last = str(page[page.length - 1].project_id);
      if (page.length < limit || !last) break;
      after = last;
    }
  }
  const budgetHit = read >= INTENTS_PER_PASS;
  openIntentCursor = budgetHit ? last : '';
  return { intents, budgetHit };
}

/**
 * Запустить одну взятую строку и записать решение. Не бросает.
 *  1. 'undecided' — без попытки: 'done needs_support' (ничего не стартуем).
 *  2. Взятие брошенной строки (heEngAbandonedMark): исчерпано — решение без
 *     попытки; иначе пометка (счётчики) пишется ДО новой попытки — не
 *     записалась, попытки нет.
 *  3. Попытка с продлением аренды (runClaimedOutcome) и решение.
 * Письмо решения без попытки заблокированному аккаунту не уходит (войти он
 * не может).
 */
async function runClaimed(
  opts: HeEngAutoLaunchTickOptions & { instantlyDb: SupabaseClient },
  dueSnapshot: DueCandidate,
  claimed: HeEngAutoLaunchRow,
): Promise<void> {
  const db = opts.portalDb;
  const requestStartedAt = Date.now();
  // Решение «стартуем» могло записаться между снимком и взятием (взятие код
  // не меняет) — тогда это режим старта, а не 'undecided'.
  const due: DueCandidate =
    dueSnapshot.mode === 'undecided' && (claimed.code === 'start_pending' || claimed.code === 'start_retry')
      ? { ...dueSnapshot, mode: 'start' }
      : dueSnapshot;
  if (due.mode === 'undecided') {
    const standing = await readHeEngAccountStanding(db, due.intent.userId);
    await decideClaimed(opts, due, claimed, claimed, { kind: 'start_undecided' }, standing.kind === 'blocked');
    return;
  }
  let row = claimed;
  const abandoned = heEngAbandonedMark(due.row, claimed, due.mode === 'start');
  if (abandoned) {
    if (abandoned.giveUp) {
      const standing = await readHeEngAccountStanding(db, due.intent.userId);
      await decideClaimed(
        opts,
        due,
        claimed,
        abandoned.row,
        { kind: 'abandoned', start: due.mode === 'start' },
        standing.kind === 'blocked',
      );
      return;
    }
    const marked = await recordHeEngAutoLaunchMark(db, claimed, abandoned.mark);
    if (marked !== 'ok') {
      // Счёт брошенных не записался — новой попытки нет (иначе платные
      // повторы не считались бы); строка вернётся к тику по истечении аренды.
      opts.log('warn', `[auto-launch] project=${due.projectId} template=${due.templateId} abandoned mark not written: ${marked}`);
      return;
    }
    row = abandoned.row;
    opts.log(
      'warn',
      `[auto-launch] project=${due.projectId} template=${due.templateId} previous attempt was abandoned ` +
        `(mode=${due.mode} retries=${row.retries} paid_failures=${row.paid_failures} start_retries=${row.start_retries})`,
    );
  }
  let outcome: HeEngAutoLaunchOutcome;
  const stopHeartbeat = startHeEngAutoLaunchLeaseHeartbeat(db, claimed);
  try {
    outcome = await runClaimedOutcome(opts, due, row, requestStartedAt);
  } finally {
    stopHeartbeat();
  }
  await decideClaimed(opts, due, claimed, row, outcome, false);
}

/**
 * Попытка по взятой строке — те же проверки, что у кнопки, в том же порядке:
 * аккаунт (бан, роль, демо — у кнопки это requireClientAuth) →
 * requireEngMarket → loadClientHeTemplate → запуск или повтор старта; перед
 * самим стартом — heEngStartGate (аккаунт ещё раз, автозапуск проекта не
 * отменён, запись 'start_pending').
 */
async function runClaimedOutcome(
  opts: HeEngAutoLaunchTickOptions & { instantlyDb: SupabaseClient },
  due: DueCandidate,
  claimed: HeEngAutoLaunchRow,
  requestStartedAt: number,
): Promise<HeEngAutoLaunchOutcome> {
  const db = opts.portalDb;
  const userId = due.intent.userId;
  const startOnly = due.mode === 'start' || claimed.code === 'start_retry';
  const standing = await readHeEngAccountStanding(db, userId);
  if (standing.kind !== 'ok') {
    opts.log(
      'warn',
      `[auto-launch] project=${due.projectId} template=${due.templateId} account ` +
        (standing.kind === 'blocked' ? `blocked (${standing.reason})` : `not read: ${standing.message}`),
    );
    return { kind: 'account', standing: standing.kind, start: startOnly };
  }
  const gate = await requireEngMarket(db, userId);
  if (!gate.ok) return { kind: 'scope', status: gate.failure.status, start: startOnly };
  const owned = await loadClientHeTemplate(db, due.templateId, userId);
  if (!owned.ok) return { kind: 'scope', status: owned.failure.status, start: startOnly };
  const onStartDecided = heEngStartGate(db, { userId, templateId: due.templateId, claimed, projectId: due.projectId });
  if (startOnly) {
    return {
      kind: 'start_retry',
      verdict: await retryHeEngLaunchStart({
        portalDb: db,
        instantlyDb: opts.instantlyDb,
        userId,
        templateId: due.templateId,
        owned: { project: owned.project, template: owned.template },
        trigger: 'auto',
        requestStartedAt,
        onStartDecided,
      }),
    };
  }
  const result = await runHeEngTemplateLaunch({
    portalDb: db,
    instantlyDb: opts.instantlyDb,
    userId,
    templateId: due.templateId,
    owned: { project: owned.project, template: owned.template },
    sendingWindow: heEngIntentSendingWindow(due.intent),
    startSending: true,
    trigger: 'auto',
    requestStartedAt,
    onStartDecided,
  });
  return result.summary;
}

/**
 * Решение по итогу: строка, журнал, письма, алерт. Не бросает. `claimed` —
 * взятие (условие записи), `row` — счётчики для решения (после пометки
 * брошенной попытки); `quiet` — без писем клиенту.
 */
async function decideClaimed(
  opts: HeEngAutoLaunchTickOptions,
  due: DueCandidate,
  claimed: HeEngAutoLaunchRow,
  row: HeEngAutoLaunchRow,
  outcome: HeEngAutoLaunchOutcome,
  quiet: boolean,
): Promise<void> {
  const db = opts.portalDb;
  const userId = due.intent.userId;
  const decision = heEngAutoLaunchVerdict(outcome, row, new Date());
  const recorded = await recordHeEngAutoLaunchDecision(db, claimed, decision);
  opts.log(
    recorded === 'ok' ? 'info' : 'warn',
    `[auto-launch] project=${due.projectId} template=${due.templateId} outcome=${decision.outcome} ` +
      `state=${decision.state} code=${decision.code ?? '-'} next=${decision.nextAt}` +
      (recorded === 'ok' ? '' : ` (row write: ${recorded})`),
  );
  void logAudit('he.eng_auto_launch.decided', 'ENG auto launch attempt decided', {
    userId,
    projectId: due.projectId,
    templateId: due.templateId,
    trigger: 'auto',
    mode: due.mode,
    outcome: decision.outcome,
    state: decision.state,
    code: decision.code,
    nextAt: decision.nextAt,
    attempts: claimed.attempts,
    paidFailures: decision.paidFailures,
    startRetries: decision.startRetries,
    recorded,
  });

  if (opts.mail && !quiet) {
    for (const notice of decision.notices) {
      try {
        await opts.mail.send(db, {
          kind: notice.kind,
          projectId: due.projectId,
          templateId: due.templateId,
          code: notice.code ?? null,
          refId: notice.refId ?? null,
        });
      } catch (e) {
        opts.log('warn', `[auto-launch] notice ${notice.kind} not sent: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }
  }
  const alertCode = decision.alertCode ?? decision.code;
  if (decision.alert && alertCode) {
    void notifyHeEngSending({
      kind: 'auto_launch_stuck',
      projectId: due.projectId,
      templateId: due.templateId,
      code: alertCode,
    });
  }
}

/**
 * Тик автозапуска (воркер движка, между джобами, не чаще раза в
 * HE_ENG_AUTO_LAUNCH_TICK_MS):
 *  1. почтовый проход (engClientMail.runHeEngClientMailScan) — независимо от
 *     выключателя автозапуска;
 *  2. ОТКРЫТЫЕ намерения (wanted, не исполнены) — один проход с вращающимся
 *     курсором, ≤ INTENTS_PER_PASS (readOpenIntentsPass; упёрся в бюджет —
 *     строка warn, следующий проход продолжает дальше), их проекты (autopilot,
 *     researched, us, владелец = нажавший, не отменён после нажатия),
 *     выбранные вертикали, их шаблоны и строки;
 *  3. исполненные намерения (heEngLaunchSettled: у каждой выбранной вертикали
 *     законченный запуск без отложенного старта) получают settled_at и
 *     дальше не читаются до нового «Launch»;
 *  4. кандидаты, которым пора (isDue); у строки 'held' sending_not_enabled
 *     выключатель сначала ЧИТАЕТСЯ (без записи и алерта) — пока не включён,
 *     строку не берём (иначе алерт команде каждые 10 минут);
 *  5. самого старого берём (he_eng_auto_launch_claim), перехватили — следующего
 *     (до CLAIMS_PER_TICK);
 *  6. запуск тем же вызовом, что «Launch now» (runClaimed: брошенная прошлая
 *     попытка сначала считается, аккаунт проверяется до попытки, перед
 *     стартом — аккаунт и отмена автозапуска проекта), решение в строку,
 *     письмо, алерт, строка лога `[auto-launch] …`.
 * Не больше ОДНОГО запуска за тик. true — запуск был (воркер сразу идёт
 * дальше по очереди). НЕ БРОСАЕТ.
 */
export async function runHeEngAutoLaunchTick(opts: HeEngAutoLaunchTickOptions): Promise<boolean> {
  const db = opts.portalDb;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  try {
    if (opts.mail?.scan) {
      try {
        await opts.mail.scan(db, { now });
      } catch (e) {
        opts.log('warn', `[auto-launch] mail scan failed: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }
    if (!heEngAutoLaunchEnabled(opts.env)) return false;
    const instantlyDb = opts.instantlyDb;
    if (!instantlyDb) {
      if (!warnedOnce.has('no_instantly_db')) {
        opts.log('warn', '[auto-launch] instantly DB client is not configured — automatic launch is off in this process');
      }
      warnOnce('no_instantly_db', 'instantly DB client missing — ENG automatic launch off');
      return false;
    }
    if (opts.shouldStop()) return false;

    // 1. Открытые намерения — один проход с вращающимся курсором.
    const pass = await readOpenIntentsPass(db);
    if ('error' in pass) {
      if (isMissing(pass.error)) {
        if (!warnedOnce.has('intent_missing')) {
          opts.log('warn', '[auto-launch] he_eng_launch_intent is missing (migration 20261012_0001 not applied) — automatic launch is off');
        }
        warnOnce('intent_missing', 'he_eng_launch_intent missing (migration 20261012_0001) — ENG automatic launch off');
      } else {
        opts.log('warn', `[auto-launch] ${errText('intents read', pass.error)}`);
      }
      return false;
    }
    if (pass.budgetHit) {
      opts.log(
        'warn',
        `[auto-launch] this pass read its budget of ${INTENTS_PER_PASS} open launch intents — the next pass ` +
          `continues after project ${openIntentCursor}`,
      );
    }
    const intents = pass.intents;
    if (intents.length === 0) return false;
    const intentByProject = new Map(intents.map((i) => [i.projectId, i]));

    // 2. Проекты (колонки отметки отмены может не быть — 20261009_0002).
    const projectIds = [...intentByProject.keys()];
    let projectsRead = await readChunked<Record<string, unknown>>(projectIds, (chunk) =>
      db.from('he_projects').select('id, created_by, status, market, autopilot, cancelled_at').in('id', chunk),
    );
    if ('error' in projectsRead && isHeMissingColumnError(projectsRead.error as { code?: string })) {
      projectsRead = await readChunked<Record<string, unknown>>(projectIds, (chunk) =>
        db.from('he_projects').select('id, created_by, status, market, autopilot').in('id', chunk),
      );
    }
    if ('error' in projectsRead) {
      opts.log('warn', `[auto-launch] ${errText('projects read', projectsRead.error)}`);
      return false;
    }
    const liveProjectIds = projectsRead.rows
      .filter((p) => {
        const intent = intentByProject.get(str(p.id));
        return intent ? projectQualifies(p, intent) : false;
      })
      .map((p) => str(p.id));
    if (liveProjectIds.length === 0) return false;

    // 3. Вертикали, выбор, шаблоны выбранных вертикалей, строки.
    const [verticalsRead, hypothesesRead, rowsRead] = await Promise.all([
      readChunked<Record<string, unknown>>(liveProjectIds, (chunk) =>
        db.from('he_verticals').select('id, project_id').in('project_id', chunk),
      ),
      readChunked<Record<string, unknown>>(liveProjectIds, (chunk) =>
        db.from('he_hypotheses').select('vertical_id, status').in('project_id', chunk).eq('status', 'accepted'),
      ),
      readChunked<Record<string, unknown>>(liveProjectIds, (chunk) =>
        db.from(HE_ENG_AUTO_LAUNCH_TABLE).select(ROW_COLUMNS).in('project_id', chunk),
      ),
    ]);
    for (const [what, read] of [
      ['verticals', verticalsRead],
      ['hypotheses', hypothesesRead],
      ['auto rows', rowsRead],
    ] as const) {
      if ('error' in read) {
        if (what === 'auto rows' && isMissing(read.error)) {
          warnOnce('rows_missing', 'he_eng_auto_launch missing (migration 20261012_0001) — ENG automatic launch off');
        } else {
          opts.log('warn', `[auto-launch] ${errText(`${what} read`, read.error)}`);
        }
        return false;
      }
    }
    if ('error' in verticalsRead || 'error' in hypothesesRead || 'error' in rowsRead) return false;
    const selectedVerticals = new Set(hypothesesRead.rows.map((h) => str(h.vertical_id)).filter(Boolean));
    const verticalIds = verticalsRead.rows.map((v) => str(v.id)).filter((id) => selectedVerticals.has(id));
    if (verticalIds.length === 0) return false;
    const templatesRead = await readChunked<Record<string, unknown>>(verticalIds, (chunk) =>
      db.from('he_templates').select(TEMPLATE_MARK_COLUMNS).in('vertical_id', chunk),
    );
    if ('error' in templatesRead) {
      opts.log('warn', `[auto-launch] ${errText('templates read', templatesRead.error)}`);
      return false;
    }
    const rowByTemplate = new Map<string, HeEngAutoLaunchRow>();
    for (const raw of rowsRead.rows) {
      const row = toRow(raw);
      if (row) rowByTemplate.set(row.template_id, row);
    }

    // 4. Кандидаты, которым пора; исполненные намерения (heEngLaunchSettled).
    const due: DueCandidate[] = [];
    const settled: HeEngLaunchIntent[] = [];
    for (const projectId of liveProjectIds) {
      const intent = intentByProject.get(projectId);
      if (!intent) continue;
      const verticals = verticalsRead.rows.filter((v) => str(v.project_id) === projectId);
      const ids = new Set(verticals.map((v) => str(v.id)));
      const projectHypotheses = hypothesesRead.rows.filter((h) => ids.has(str(h.vertical_id)));
      const projectTemplates = templatesRead.rows.filter((t) => ids.has(str(t.vertical_id)));
      if (
        heEngLaunchSettled({
          verticals,
          hypotheses: projectHypotheses,
          templates: projectTemplates,
          rows: rowByTemplate,
          nowMs,
        })
      ) {
        settled.push(intent);
        continue;
      }
      const candidates = heEngAutoLaunchCandidates({
        verticals,
        hypotheses: projectHypotheses,
        templates: projectTemplates,
        nowMs,
      });
      for (const c of candidates) {
        const row = rowByTemplate.get(c.templateId) ?? null;
        if (!isDue(row, nowMs)) continue;
        due.push({
          projectId,
          templateId: c.templateId,
          verticalId: c.verticalId,
          intent,
          row,
          mode: 'launch',
          orderMs: row ? tsOf(row.next_at) : tsOf(c.createdAt),
        });
      }
      // Законченный запуск, у которого старт не сделан: решённый старт
      // (повтор, брошенный после решения, отложенный блокировкой аккаунта) —
      // режим 'start'; строка, брошенная до решения, — 'undecided' (ничего не
      // стартуем). Кандидатом такой шаблон не бывает (у вертикали законченный
      // запуск), поэтому отдельно.
      for (const t of projectTemplates) {
        const row = rowByTemplate.get(str(t.id));
        if (!row) continue;
        const view = templateViewOf(t, nowMs);
        if (!view || !view.launched || view.incomplete || view.leaseLive) continue;
        const decided = startDecided(row);
        if (!(decided || row.state === 'running') || !isDue(row, nowMs)) continue;
        due.push({
          projectId,
          templateId: view.id,
          verticalId: view.verticalId,
          intent,
          row,
          mode: decided ? 'start' : 'undecided',
          orderMs: tsOf(row.next_at),
        });
      }
    }
    // Исполненные — отметка settled_at: дальше проходы их не читают (до
    // нового «Launch»). Не записалась — проект просто прочитается снова.
    for (const intent of settled) {
      if (opts.shouldStop()) return false;
      const res = await settleHeEngLaunchIntent(db, intent, now.toISOString());
      if (res === 'ok') {
        opts.log('info', `[auto-launch] project=${intent.projectId} settled: every selected market has a finished launch`);
      } else if (res === 'error') {
        opts.log('warn', `[auto-launch] project=${intent.projectId} settle mark not written`);
      }
    }
    if (due.length === 0) return false;
    due.sort((a, b) => a.orderMs - b.orderMs);

    // 5. Взять и запустить одного.
    const accessByUser = new Map<string, boolean>();
    let claimsLeft = CLAIMS_PER_TICK;
    for (const candidate of due) {
      if (claimsLeft <= 0 || opts.shouldStop()) return false;
      if (candidate.row?.state === 'held' && candidate.row.code === 'sending_not_enabled') {
        let allows = accessByUser.get(candidate.intent.userId);
        if (allows === undefined) {
          const access = await readHeEngSendingAccess(db, candidate.intent.userId);
          allows = heEngSendingAccessAllows(access.state);
          accessByUser.set(candidate.intent.userId, allows);
        }
        if (!allows) continue;
      }
      claimsLeft -= 1;
      const claim = await claimHeEngAutoLaunch(db, {
        templateId: candidate.templateId,
        projectId: candidate.projectId,
        manual: false,
      });
      if (claim.kind === 'busy') continue;
      if (claim.kind === 'missing') {
        warnOnce('claim_missing', 'he_eng_auto_launch_claim missing (migration 20261012_0001) — ENG automatic launch off');
        return false;
      }
      if (claim.kind === 'error') {
        opts.log('warn', `[auto-launch] claim failed: ${claim.message}`);
        return false;
      }
      await runClaimed({ ...opts, instantlyDb }, candidate, claim.row);
      return true;
    }
    return false;
  } catch (e) {
    opts.log('error', `[auto-launch] tick failed: ${e instanceof Error ? e.message : 'unknown'}`);
    return false;
  }
}
