import type { SupabaseClient } from '@supabase/supabase-js';
import { readVe2SendingSwitch } from '@/lib/sender/ve2SendingSwitch';

/**
 * Куда идут запуски VE2: Instantly или своя «Рассылка» (решение владельца
 * 24.10.2026: новые запуски вертикалей — через «Рассылку»).
 *
 * Выбор делается один раз, при запуске, и записывается в сам запуск
 * (launch_info.transport → строки очереди, миграция 20261024_0020): идущие
 * запуски никуда не переезжают. Любая ошибка чтения настроек — Instantly,
 * то есть прежнее поведение.
 */

export type VeLaunchTransport = 'instantly' | 'sender';
export type VeLaunchTransportMode = 'instantly' | 'pilot' | 'sender' | 'choice';

/** Откуда взялось решение — для журнала запуска. */
export type VeLaunchTransportSource = 'env_kill' | 'market' | 'override' | 'default' | 'error' | 'requested';

/** Запасной выключатель: переменная окружения главнее настроек в базе. */
export const VE2_SENDER_LAUNCHES_DISABLED_ENV = 'VE2_SENDER_LAUNCHES_DISABLED';

/** Значение из базы или запуска; всё, кроме 'sender', — Instantly. */
export function transportOf(value: unknown): VeLaunchTransport {
  return value === 'sender' ? 'sender' : 'instantly';
}

/**
 * Решение по настройкам: режим рынка instantly главнее переопределения проекта
 * (это и есть аварийный выключатель); pilot — «Рассылка» только проектам с
 * переопределением 'sender'; sender — всем, кроме переопределённых в 'instantly'.
 */
/** @deprecated Этап 7: способ отправки выбирает специалист — resolveRequestedVeLaunchTransport. Оставлено для старых проверок. */
export function decideVeLaunchTransport(input: {
  killed: boolean;
  mode: unknown;
  override: unknown;
}): { transport: VeLaunchTransport; source: VeLaunchTransportSource } {
  if (input.killed) return { transport: 'instantly', source: 'env_kill' };
  if (input.mode === 'pilot') {
    return input.override === 'sender'
      ? { transport: 'sender', source: 'override' }
      : { transport: 'instantly', source: 'market' };
  }
  if (input.mode === 'sender') {
    return input.override === 'instantly'
      ? { transport: 'instantly', source: 'override' }
      : { transport: 'sender', source: 'market' };
  }
  if (input.mode === 'instantly') return { transport: 'instantly', source: 'market' };
  return { transport: 'instantly', source: 'default' };
}

/** Включён ли запасной выключатель в окружении этого процесса (только да/нет, без значения). */
export function killedByEnv(env: Record<string, string | undefined>): boolean {
  const value = String(env[VE2_SENDER_LAUNCHES_DISABLED_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

interface ProjectTransportRow {
  market: string | null;
  launch_transport_override: string | null;
}

async function readProjectAndSettings(
  portalDb: SupabaseClient,
  veProjectId: string,
): Promise<{ project: ProjectTransportRow; settings: { mode: unknown; sender_uploads_enabled: unknown } | null }> {
  const { data: project, error } = await portalDb
    .from('ve_projects')
    .select('market, launch_transport_override')
    .eq('id', veProjectId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!project) throw new Error(`проект VE2 ${veProjectId} не найден`);
  const market = (project as ProjectTransportRow).market ?? 'ru';
  const { data: settings, error: settingsError } = await portalDb
    .from('ve_launch_transport_settings')
    .select('mode, sender_uploads_enabled')
    .eq('market', market)
    .maybeSingle();
  if (settingsError) throw new Error(settingsError.message);
  return { project: project as ProjectTransportRow, settings: settings ?? null };
}

/**
 * Рынки, где новые запуски могут идти в «Рассылку», — для плашки над списком
 * проектов. Выключатель окружения и ошибка чтения — пусто, то есть Instantly.
 * Отдаём только режим, не значения окружения.
 */
export async function readVeSenderMarkets(
  portalDb: SupabaseClient,
  env: Record<string, string | undefined> = process.env,
): Promise<Array<{ market: string; mode: 'pilot' | 'sender'; sender_uploads_enabled: boolean }>> {
  if (killedByEnv(env)) return [];
  try {
    const { data, error } = await portalDb.from('ve_launch_transport_settings').select('market, mode, sender_uploads_enabled');
    if (error) return [];
    return ((data ?? []) as Array<{ market: unknown; mode: unknown; sender_uploads_enabled: unknown }>)
      .filter((row) => typeof row.market === 'string' && (row.mode === 'pilot' || row.mode === 'sender'))
      .map((row) => ({ market: row.market as string, mode: row.mode as 'pilot' | 'sender', sender_uploads_enabled: row.sender_uploads_enabled === true }))
      .sort((left, right) => left.market.localeCompare(right.market));
  } catch {
    return [];
  }
}

/** Куда пойдёт новый запуск проекта. Ошибка, нет строки или непонятное значение — Instantly. */
/** @deprecated Этап 7: способ отправки выбирает специалист — resolveRequestedVeLaunchTransport. Оставлено для старых проверок. */
export async function resolveVeLaunchTransport(
  portalDb: SupabaseClient,
  veProjectId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ transport: VeLaunchTransport; source: VeLaunchTransportSource }> {
  if (killedByEnv(env)) return { transport: 'instantly', source: 'env_kill' };
  try {
    const { project, settings } = await readProjectAndSettings(portalDb, veProjectId);
    if (!settings) return { transport: 'instantly', source: 'default' };
    return decideVeLaunchTransport({ killed: false, mode: settings.mode, override: project.launch_transport_override });
  } catch {
    return { transport: 'instantly', source: 'error' };
  }
}

/**
 * Специалист запускает то, что видел в обзоре запуска: способ отправки из
 * обзора приходит с запуском (expected_transport; нет — Instantly) и обязан
 * совпасть с тем, что решает переключатель сейчас. Иначе — отказ, а не тихая
 * смена канала. Ошибка чтения настроек при ожидаемой «Рассылке» — 503:
 * «способ изменился» было бы неправдой.
 */
/** @deprecated Этап 7: способ отправки выбирает специалист — resolveRequestedVeLaunchTransport. Оставлено для старых проверок. */
export function transportExpectationIssue(
  resolved: { transport: VeLaunchTransport; source: VeLaunchTransportSource },
  expected: unknown,
): null | { status: number; code: string; error: string } {
  if (expected !== undefined && expected !== null && expected !== 'instantly' && expected !== 'sender') {
    return { status: 400, code: 'VE_LAUNCH_TRANSPORT_INVALID', error: 'Некорректный способ отправки' };
  }
  if (resolved.transport === (expected ?? 'instantly')) return null;
  if (resolved.source === 'error') {
    return { status: 503, code: 'VE_LAUNCH_TRANSPORT_UNAVAILABLE', error: 'Не удалось проверить способ отправки. Повторите.' };
  }
  return { status: 409, code: 'VE_LAUNCH_TRANSPORT_CHANGED', error: 'Способ отправки изменился — обновите обзор запуска.' };
}

// ─── Выбор специалиста при запуске (этап 7, решение владельца 26.10.2026) ─────
//
// Способ отправки запуска — тот, что выбрал специалист; по умолчанию Instantly.
// Instantly разрешён всегда и выключатели при этом даже не читаются: запуск или
// автоаутрич в Instantly не может встать из-за переключения «Рассылки».
// «Рассылку» разрешают выключатели администратора; не разрешили — отказ с
// причиной, а не тихая подмена на Instantly.

/**
 * offered — показывать ли специалисту вариант «Рассылка» вообще (нет — экран
 * как раньше, только Instantly); allowed — можно ли выбрать его сейчас.
 */
export type VeSenderLaunchAvailability =
  | { allowed: true; offered: true }
  | {
    allowed: false;
    offered: boolean;
    status: 409 | 503;
    code: 'VE_LAUNCH_SENDER_DISABLED' | 'VE_LAUNCH_TRANSPORT_UNAVAILABLE';
    reason: string;
  };

/**
 * new — новый выбор (обзор, запуск, приём автоаутрича): нужны и разрешение, и
 * включённые подача и отправка. accepted — уже принятый запуск автоаутрича:
 * только разрешение (запасной выключатель, США, режим рынка, проект); при
 * выключенной подаче или остановленной отправке его гипотезы ждут, а не
 * останавливаются навсегда (так обещает панель этапа 6).
 */
export type VeSenderAvailabilityScope = 'new' | 'accepted';

const SENDER_UNKNOWN: VeSenderLaunchAvailability = {
  allowed: false, offered: true, status: 503, code: 'VE_LAUNCH_TRANSPORT_UNAVAILABLE',
  reason: 'Не удалось проверить, доступна ли «Рассылка». Повторите.',
};

/** Можно ли запустить в «Рассылку». null у выключателей — не прочитали: не знаем, значит нельзя. */
export function veSenderLaunchAvailability(input: {
  killed: boolean;
  market: string | null;
  mode: unknown;
  modeBeforeStop?: unknown;
  override: unknown;
  sendingEnabled: boolean | null;
  uploadsEnabled: boolean | null;
}, scope: VeSenderAvailabilityScope = 'new'): VeSenderLaunchAvailability {
  const off = (offered: boolean, reason: string): VeSenderLaunchAvailability => ({
    allowed: false, offered, status: 409, code: 'VE_LAUNCH_SENDER_DISABLED', reason,
  });
  if (input.killed) return off(false, 'Запуски в «Рассылку» выключены запасным выключателем в настройках портала — только Instantly.');
  if ((input.market ?? 'ru') !== 'ru') return off(false, 'Для США — только Instantly.');
  if (input.override === 'instantly') return off(false, 'Проект оставлен на Instantly.');
  const modeAllows = input.mode === 'choice' || input.mode === 'sender' || (input.mode === 'pilot' && input.override === 'sender');
  if (!modeAllows) {
    if (input.mode === 'pilot') return off(false, 'Пилот «Рассылки» идёт на других проектах — этот запускается в Instantly.');
    // Выбор был и его временно сняли «только Instantly» — вариант виден, но недоступен.
    const stopped = input.mode === 'instantly' && ['choice', 'sender', 'pilot'].includes(String(input.modeBeforeStop ?? ''));
    return off(stopped, stopped
      ? 'Администратор временно оставил новые запуски только в Instantly.'
      : 'Выбор «Рассылки» не включён — новые запуски только в Instantly.');
  }
  if (scope === 'accepted') return { allowed: true, offered: true };
  if (input.sendingEnabled === null || input.uploadsEnabled === null) return SENDER_UNKNOWN;
  if (!input.sendingEnabled) return off(true, 'Отправка кампаний Движка в «Рассылке» остановлена администратором.');
  if (!input.uploadsEnabled) return off(true, 'Подача контактов в «Рассылку» выключена администратором.');
  return { allowed: true, offered: true };
}

/** То же по базе: проект, рынок, выключатели этапа 6. Не бросает: сбой чтения — «не знаем». */
export async function readVeSenderLaunchAvailability(
  portalDb: SupabaseClient,
  veProjectId: string,
  env: Record<string, string | undefined> = process.env,
  scope: VeSenderAvailabilityScope = 'new',
): Promise<VeSenderLaunchAvailability> {
  if (killedByEnv(env)) {
    return veSenderLaunchAvailability({ killed: true, market: null, mode: null, override: null, sendingEnabled: null, uploadsEnabled: null }, scope);
  }
  try {
    const { data: project, error } = await portalDb.from('ve_projects')
      .select('market, launch_transport_override').eq('id', veProjectId).maybeSingle();
    if (error || !project) return SENDER_UNKNOWN;
    const row = project as ProjectTransportRow;
    const market = row.market ?? 'ru';
    const { data: settings, error: settingsError } = await portalDb.from('ve_launch_transport_settings')
      .select('mode, mode_before_stop, sender_uploads_enabled').eq('market', market).maybeSingle();
    if (settingsError) return SENDER_UNKNOWN;
    const marketRow = settings as { mode: unknown; mode_before_stop: unknown; sender_uploads_enabled: unknown } | null;
    const sending = scope === 'new' ? await readVe2SendingSwitch(portalDb) : null;
    return veSenderLaunchAvailability({
      killed: false,
      market,
      mode: marketRow?.mode ?? null,
      modeBeforeStop: marketRow?.mode_before_stop ?? null,
      override: row.launch_transport_override,
      sendingEnabled: sending === null ? true : sending.state === 'unknown' ? null : sending.state === 'enabled',
      uploadsEnabled: marketRow ? marketRow.sender_uploads_enabled === true : false,
    }, scope);
  } catch {
    return SENDER_UNKNOWN;
  }
}

export type VeRequestedTransport =
  | { ok: true; transport: VeLaunchTransport; source: VeLaunchTransportSource }
  | { ok: false; status: number; code: string; error: string };

/**
 * Способ отправки запуска по выбору специалиста. Не выбрано или Instantly —
 * Instantly без чтения настроек; «Рассылка» — только если её разрешают
 * выключатели прямо сейчас.
 */
export async function resolveRequestedVeLaunchTransport(
  portalDb: SupabaseClient,
  veProjectId: string,
  requested: unknown,
  env: Record<string, string | undefined> = process.env,
  scope: VeSenderAvailabilityScope = 'new',
): Promise<VeRequestedTransport> {
  if (requested !== undefined && requested !== null && requested !== 'instantly' && requested !== 'sender') {
    return { ok: false, status: 400, code: 'VE_LAUNCH_TRANSPORT_INVALID', error: 'Некорректный способ отправки' };
  }
  if (requested !== 'sender') return { ok: true, transport: 'instantly', source: 'requested' };
  const availability = await readVeSenderLaunchAvailability(portalDb, veProjectId, env, scope);
  if (!availability.allowed) return { ok: false, status: availability.status, code: availability.code, error: availability.reason };
  return { ok: true, transport: 'sender', source: 'requested' };
}

/** Для экрана: показывать ли «Рассылку», можно ли выбрать и почему нет (без кодов ответа). */
export interface VeSenderOptionView {
  offered: boolean;
  allowed: boolean;
  reason: string | null;
  /** Не прочитали выключатели — повтор проверки может помочь (экран предлагает «Повторить проверку»). */
  retryable?: true;
}

export function veSenderOptionView(availability: VeSenderLaunchAvailability, letterIssue?: string | null): VeSenderOptionView {
  if (!availability.allowed) {
    return { offered: availability.offered, allowed: false, reason: availability.reason, ...(availability.status === 503 ? { retryable: true as const } : {}) };
  }
  if (letterIssue) return { offered: true, allowed: false, reason: letterIssue };
  return { offered: true, allowed: true, reason: null };
}

/** Можно ли подавать контакты в кампании «Рассылки» проекта. Ошибка — нельзя. */
export async function readSenderUploadsEnabled(portalDb: SupabaseClient, veProjectId: string): Promise<boolean> {
  try {
    const { settings } = await readProjectAndSettings(portalDb, veProjectId);
    return settings?.sender_uploads_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Статус кампании «Рассылки» в числах статусов Instantly (remote_status очереди
 * VE2). Остановленная («done») — 3, «завершена»: по нему очередь отпускает
 * запуск и находит его при восстановлении, как у Instantly.
 *
 * Отличие одно: у Instantly в завершённую кампанию ещё можно подавать, а в
 * остановленную кампанию «Рассылки» новые получатели никогда не уйдут. Поэтому
 * подача в «Рассылку» смотрит сам sender_campaigns.status, а не это число.
 */
export const SENDER_REMOTE_STATUS = { draft: 0, running: 1, paused: 2, done: 3 } as const;

export function senderRemoteStatus(status: string): number {
  if (status in SENDER_REMOTE_STATUS) return SENDER_REMOTE_STATUS[status as keyof typeof SENDER_REMOTE_STATUS];
  throw new Error(`неизвестный статус кампании «Рассылки»: ${status}`);
}

/** Ссылка на кампанию «Рассылки» в портале (относительная — тот же сайт). */
export function senderCampaignUrl(campaignId: string): string {
  return `/tools/sender/campaigns/${campaignId}`;
}
