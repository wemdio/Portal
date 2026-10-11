/**
 * ENG: выключатель отправки аккаунта (решение владельца 10–11.10.2026).
 *
 * Пока в кабинете нет оплаты, отправку НОВОГО аккаунта один раз включает
 * сотрудник — защита от злоупотреблений, а не проверка писем. Требование по
 * умолчанию ВКЛЮЧЕНО и снимается одной переменной окружения:
 * HE_US_SENDING_REQUIRES_ACTIVATION = 0 / false / off / no (без учёта регистра).
 * Любое другое значение (и пусто) — требование действует.
 *
 * ВЫКЛЮЧЕНИЕ СОТРУДНИКОМ ДЕЙСТВУЕТ ВСЕГДА. Строка аккаунта читается и при
 * снятом требовании: enabled=false с revoked_at — 'revoked', отказ везде
 * (запуск, «Start sending» / «Resume», ночной долив). Снятое требование меняет
 * только то, что без явного выключения: нет строки, строка «ещё не включали»
 * (enabled=false без revoked_at) или нет таблицы (42P01 / PGRST205 — выключить
 * было негде) — 'not_required' (отправка разрешена: включать никого не
 * нужно). Любой другой сбой чтения строки (и брошенное чтение) — 'error' при
 * любом значении требования: он мог скрыть выключение сотрудником, и старт
 * отказан (пауза и доводка паузы выключатель не спрашивают). При действующем
 * требовании нет строки / «ещё не включали» — 'not_enabled', нет таблицы —
 * 'unavailable'; оба отказывают.
 *
 * Таблица he_eng_sending_access (миграция 20261011_0002, её шапка — колонки и
 * состояния). Это НЕ client_tariffs.is_active: тот флаг читают RU-гейты тарифа.
 *
 * ГДЕ СТОИТ (каждый путь, который начинает отправку): роут запуска кабинета —
 * до выдачи ящиков пула и до ядра (api/client/eng/templates/[id]/launch), и
 * startHeEngLaunchSending (engCampaignSending.ts) — сам, внутри, поэтому любой
 * его вызывающий (запуск, «Start sending», «Resume») получает проверку; там же
 * выключатель перечитывается перед КАЖДЫМ POST /activate и после цикла
 * (выключение сотрудником посреди старта ставит стартованное этим вызовом на
 * паузу). Ночной долив читает его в проверке «кампании запуска отправляют?»
 * (createHeRefillSendGate / checkHeRefillSendTarget в autoPipeline.ts) — и в
 * тике до покупки сборки, и в доливе до провайдера. Фоновое чтение статуса
 * (engCampaignStatus.refreshHeEngCampaignStatuses) ставит на паузу
 * отправляющую кампанию выключенного ('revoked') аккаунта.
 * Пауза выключатель НЕ спрашивает: остановить отправку можно всегда.
 *
 * ДЕГРАДАЦИЯ — fail-closed (в отличие от подтверждения почты, которое без
 * своей таблицы пропускает): сбой чтения — 'error' всегда; нет таблицы
 * (42P01 / PGRST205) — 'unavailable', пока требование действует, и
 * 'not_required' при снятом (таблицы нет — и выключения в ней нет).
 *
 * КОМУ. Только профилю role 'client' с market 'eng'. Сотрудник (его пускает
 * requireEngMarket) — 'not_client': этот гейт его не держит, а запуск ему
 * откажет выдача ящиков пула (ensureHeEngPresetForProject: not_eng_client).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { notifyHeEngSending } from './engSendingAlert';

export const HE_US_SENDING_REQUIRES_ACTIVATION_ENV = 'HE_US_SENDING_REQUIRES_ACTIVATION';
export const HE_ENG_SENDING_ACCESS_TABLE = 'he_eng_sending_access';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Нужен ли выключатель (дефолт — да; снимает только явное 0/false/off/no). */
export function heEngSendingActivationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[HE_US_SENDING_REQUIRES_ACTIVATION_ENV] ?? '').trim().toLowerCase();
  return !OFF_VALUES.has(raw);
}

/* ─────────────── Тексты клиенту ─────────────── */

/**
 * Отправка аккаунта ещё не включена. Правда при отказе: команде ушёл алерт
 * 'access_requested' (engSendingAlert; без кредов Telegram его нет — тогда
 * клиента видно в /admin/users по requested_at), а письмо «включено» уходит при
 * включении (engSendingAccessMail.sendHeEngSendingEnabledEmail; не ушло — экран
 * сотрудника так и пишет). «Support» кабинет рисует ссылкой.
 */
export const ENG_SENDING_NOT_ENABLED_TEXT =
  'Sending for your account is being enabled by our team — this happens once. We will email you when it is on; '
  + 'you can message Support.';

/** Сотрудник выключил отправку аккаунта. */
export const ENG_SENDING_TURNED_OFF_TEXT =
  'Sending is turned off for your account, so campaigns cannot be started. Message Support.';

/** Блип чтения выключателя — та же фраза, что у гейта платных шагов (ENG_PAID_UNAVAILABLE_TEXT). */
export const ENG_SENDING_ACCESS_BLIP_TEXT = 'Service temporarily unavailable — refresh the page';

/** Выключатель не читается (миграция, БД) — чинит команда, алерт ушёл. */
export const ENG_SENDING_ACCESS_PROBLEM_TEXT =
  'Campaigns cannot be started right now because of a problem on our side. Message Support.';

/* ─────────────── Чтение ─────────────── */

export type HeEngSendingAccessState =
  /**
   * Требование снято переменной окружения, и сотрудник аккаунт не выключал:
   * строки нет, строка «ещё не включали» или таблицы нет.
   */
  | 'not_required'
  /** Не клиент ENG (сотрудник, RU-профиль) — этот гейт не держит. */
  | 'not_client'
  | 'enabled'
  /** Требование действует; ни разу не включали (нет строки или enabled=false без revoked_at). */
  | 'not_enabled'
  /** Выключили (enabled=false, revoked_at задан) — при любом значении требования. */
  | 'revoked'
  /** Требование действует; таблицы нет (миграция не применена). */
  | 'unavailable'
  /** Сбой чтения (при любом значении требования, кроме «таблицы нет» при снятом). */
  | 'error';

export interface HeEngSendingAccess {
  state: HeEngSendingAccessState;
  requestedAt: string | null;
  enabledAt: string | null;
  revokedAt: string | null;
  emailSentAt: string | null;
  /** Адрес профиля — для алерта и письма; null — нет или не читали. */
  email: string | null;
  /** Подробность сбоя — только в журнал. */
  detail?: string;
}

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

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function empty(state: HeEngSendingAccessState, email: string | null, detail?: string): HeEngSendingAccess {
  return { state, requestedAt: null, enabledAt: null, revokedAt: null, emailSentAt: null, email, ...(detail ? { detail } : {}) };
}

/**
 * Состояние выключателя аккаунта. НЕ БРОСАЕТ. Строка аккаунта читается всегда
 * (выключение сотрудником действует и при снятом требовании, см. шапку).
 * `skipEnv` — для экрана сотрудника: состояние строки как при действующем
 * требовании (что включено, что выключено, чего ждёт клиент).
 */
export async function readHeEngSendingAccess(
  db: SupabaseClient,
  userId: string,
  opts: { env?: NodeJS.ProcessEnv; skipEnv?: boolean } = {},
): Promise<HeEngSendingAccess> {
  const required = opts.skipEnv === true || heEngSendingActivationRequired(opts.env);
  try {
    const { data: profileRow, error: profileErr } = await db
      .from('profiles')
      .select('role, market, email')
      .eq('id', userId)
      .maybeSingle();
    // 42703 — колонки market нет: рынок неизвестен, это не ENG-клиент.
    // Сбой чтения профиля при снятом требовании — строку выключателя всё равно
    // читаем: выключение сотрудником должно держать и тогда.
    const profileFailed = !!profileErr && profileErr.code !== '42703';
    if (profileFailed && required) return empty('error', null, errText('profiles read', profileErr));
    const profile = (profileErr ? null : profileRow) as { role?: unknown; market?: unknown; email?: unknown } | null;
    const email = str(profile?.email);
    if (!profileFailed && (!profile || profile.role !== 'client' || profile.market !== 'eng')) {
      return empty('not_client', email);
    }

    const { data, error } = await db
      .from(HE_ENG_SENDING_ACCESS_TABLE)
      .select('enabled, requested_at, enabled_at, revoked_at, email_sent_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      // Снятое требование пропускает только «таблицы нет» (миграция не
      // применена — выключить аккаунт было негде); любой другой сбой чтения
      // мог скрыть выключение сотрудником — 'error' (старт отказан).
      if (isTableMissing(error)) {
        const detail = errText('he_eng_sending_access missing', error);
        return empty(required ? 'unavailable' : 'not_required', email, detail);
      }
      return empty('error', email, errText('he_eng_sending_access read', error));
    }
    const row = (data ?? null) as Record<string, unknown> | null;
    const base = {
      requestedAt: str(row?.requested_at),
      enabledAt: str(row?.enabled_at),
      revokedAt: str(row?.revoked_at),
      emailSentAt: str(row?.email_sent_at),
      email,
    };
    if (row?.enabled === true) return { state: 'enabled', ...base };
    if (base.revokedAt) return { state: 'revoked', ...base };
    return { state: required ? 'not_enabled' : 'not_required', ...base };
  } catch (e) {
    // Брошенное чтение — при любом значении требования 'error': выключение
    // сотрудником не прочитано, начинать отправку нельзя.
    return empty('error', null, `threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`);
  }
}

/** Пускает ли состояние начинать отправку. */
export function heEngSendingAccessAllows(state: HeEngSendingAccessState): boolean {
  return state === 'enabled' || state === 'not_required' || state === 'not_client';
}

export type HeEngSendingAccessRefusalCode =
  | 'sending_not_enabled'
  | 'sending_turned_off'
  | 'sending_access_unavailable';

export type HeEngSendingAccessGate =
  | { ok: true; state: HeEngSendingAccessState }
  | { ok: false; status: number; code: HeEngSendingAccessRefusalCode; message: string; state: HeEngSendingAccessState };

/**
 * Отказ по состоянию — без побочных действий (ни отметки «клиент ждёт», ни
 * алерта). Для повторной проверки посреди старта (engCampaignSending: перед
 * каждым POST /activate и после цикла) — гейт с записью и алертом уже прошёл
 * в начале того же вызова. null — состояние пускает.
 */
export function heEngSendingAccessRefusal(
  state: HeEngSendingAccessState,
): { status: number; code: HeEngSendingAccessRefusalCode; message: string } | null {
  switch (state) {
    case 'enabled':
    case 'not_required':
    case 'not_client':
      return null;
    case 'not_enabled':
      return { status: 403, code: 'sending_not_enabled', message: ENG_SENDING_NOT_ENABLED_TEXT };
    case 'revoked':
      return { status: 403, code: 'sending_turned_off', message: ENG_SENDING_TURNED_OFF_TEXT };
    case 'unavailable':
      return { status: 503, code: 'sending_access_unavailable', message: ENG_SENDING_ACCESS_PROBLEM_TEXT };
    case 'error':
      return { status: 503, code: 'sending_access_unavailable', message: ENG_SENDING_ACCESS_BLIP_TEXT };
  }
}

/**
 * Гейт «можно начинать отправку». Отказ 'not_enabled' записывает, что клиент
 * ждёт (requested_at — только первый раз), и шлёт команде алерт с
 * дедупликацией; 'unavailable' / 'error' — алерт о недоступности (только
 * 'unavailable': блип чтения — «обновите страницу»). НЕ БРОСАЕТ.
 */
export async function requireHeEngSendingAccess(
  db: SupabaseClient,
  userId: string,
  ctx: { projectId: string | null; via: 'launch' | 'start'; env?: NodeJS.ProcessEnv },
): Promise<HeEngSendingAccessGate> {
  const access = await readHeEngSendingAccess(db, userId, { env: ctx.env });
  switch (access.state) {
    case 'enabled':
    case 'not_required':
    case 'not_client':
      return { ok: true, state: access.state };
    case 'not_enabled': {
      await noteHeEngSendingRequest(db, userId);
      void notifyHeEngSending({
        kind: 'access_requested',
        userId,
        email: access.email,
        projectId: ctx.projectId,
        via: ctx.via,
      });
      void logAudit('he.eng_sending_access.refused', 'ENG sending refused: account sending not enabled yet', {
        userId,
        projectId: ctx.projectId,
        via: ctx.via,
      });
      return { ok: false, status: 403, code: 'sending_not_enabled', message: ENG_SENDING_NOT_ENABLED_TEXT, state: access.state };
    }
    case 'revoked':
      void logAudit('he.eng_sending_access.refused', 'ENG sending refused: account sending turned off by staff', {
        userId,
        projectId: ctx.projectId,
        via: ctx.via,
      });
      return { ok: false, status: 403, code: 'sending_turned_off', message: ENG_SENDING_TURNED_OFF_TEXT, state: access.state };
    case 'unavailable':
      void notifyHeEngSending({ kind: 'access_unavailable', reason: access.detail ?? 'he_eng_sending_access missing' });
      void logWarn('he.eng_sending_access.unavailable', 'ENG sending switch table missing — sending refused', {
        userId,
        detail: access.detail ?? null,
      });
      return {
        ok: false,
        status: 503,
        code: 'sending_access_unavailable',
        message: ENG_SENDING_ACCESS_PROBLEM_TEXT,
        state: access.state,
      };
    case 'error':
      void logWarn('he.eng_sending_access.read_failed', 'ENG sending switch unreadable — sending refused', {
        userId,
        detail: access.detail ?? null,
      });
      return {
        ok: false,
        status: 503,
        code: 'sending_access_unavailable',
        message: ENG_SENDING_ACCESS_BLIP_TEXT,
        state: access.state,
      };
  }
}

/**
 * Клиент упёрся в выключатель: строка с requested_at, если строки ещё нет
 * (повтор не двигает момент первого запроса). Сбой — строка warn; отказ
 * клиенту от неё не зависит.
 */
async function noteHeEngSendingRequest(db: SupabaseClient, userId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await db
      .from(HE_ENG_SENDING_ACCESS_TABLE)
      .upsert({ user_id: userId, requested_at: now }, { onConflict: 'user_id', ignoreDuplicates: true });
    if (error) {
      void logWarn('he.eng_sending_access.request_note_failed', errText('he_eng_sending_access insert', error), { userId });
    }
  } catch (e) {
    void logWarn('he.eng_sending_access.request_note_failed', e instanceof Error ? e.message : 'unknown', { userId });
  }
}

/* ─────────────── Сотрудник: включить / выключить ─────────────── */

export type HeEngSendingAccessSetResult =
  | { kind: 'updated'; enabled: boolean; changed: boolean; row: HeEngSendingAccess }
  | { kind: 'not_eng_client' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * Включить / выключить отправку аккаунта (экран сотрудника). Только ENG-клиенту.
 * `changed` — состояние поменялось этим вызовом (повтор того же — false).
 * Выключение пишет revoked_at любому не выключенному аккаунту, и ни разу не
 * включённому тоже: при снятом требовании такой аккаунт отправляет
 * ('not_required'), и остановить его можно только так. НЕ БРОСАЕТ. Кампании
 * выключенного аккаунта ставит на паузу вызывающий (pauseHeEngAccountSending,
 * engCampaignSending.ts).
 */
export async function setHeEngSendingAccess(
  db: SupabaseClient,
  userId: string,
  enabled: boolean,
): Promise<HeEngSendingAccessSetResult> {
  const before = await readHeEngSendingAccess(db, userId, { skipEnv: true });
  if (before.state === 'not_client') return { kind: 'not_eng_client' };
  if (before.state === 'unavailable') return { kind: 'unavailable' };
  if (before.state === 'error') return { kind: 'error', message: before.detail ?? 'read failed' };
  const already = enabled ? before.state === 'enabled' : before.state === 'revoked';
  if (already) return { kind: 'updated', enabled, changed: false, row: before };
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = enabled
    ? { user_id: userId, enabled: true, enabled_at: now }
    : { user_id: userId, enabled: false, revoked_at: now };
  try {
    const { error } = await db.from(HE_ENG_SENDING_ACCESS_TABLE).upsert(patch, { onConflict: 'user_id' });
    if (error) {
      return isTableMissing(error) ? { kind: 'unavailable' } : { kind: 'error', message: errText('he_eng_sending_access upsert', error) };
    }
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
  const after = await readHeEngSendingAccess(db, userId, { skipEnv: true });
  return { kind: 'updated', enabled, changed: true, row: after };
}
