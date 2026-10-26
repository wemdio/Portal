import type { SupabaseClient } from '@supabase/supabase-js';

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
export type VeLaunchTransportMode = 'instantly' | 'pilot' | 'sender';

/** Откуда взялось решение — для журнала запуска. */
export type VeLaunchTransportSource = 'env_kill' | 'market' | 'override' | 'default' | 'error';

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
