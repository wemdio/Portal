import type { SupabaseClient } from '@supabase/supabase-js';
import { SenderOpError, startCampaign } from '@/lib/sender/campaignOps';
import { chunkForInFilter } from '@/lib/sender/inFilter';
import { readVe2SendingSwitch, VE2_SENDING_STOPPED_CODE } from '@/lib/sender/ve2SendingSwitch';
import { killedByEnv } from './transport';

/**
 * Выключатели запусков Движка через «Рассылку» (этап 6, план 24.10.2026).
 * Что видит панель над списком проектов Движка и что делают её кнопки.
 *
 * - Новые запуски — только Instantly: режим рынка 'instantly'; что было —
 *   в mode_before_stop, «вернуть» восстанавливает его. Включить «Рассылку»
 *   впервые отсюда нельзя (это пилот, этап 7).
 * - Подача контактов в «Рассылку»: sender_uploads_enabled рынка.
 * - Отправка кампаний Движка: сначала флаг (своей транзакцией — запуск, уже
 *   проверивший флаг, держит его строку до своего коммита), потом пауза идущих
 *   кампаний ve2 и снятие назначенных запусков (ve_sender_pause_running).
 *   Продолжение запускает только то, что остановил выключатель и чего люди
 *   после остановки не трогали.
 * - Карточки лидов (этап 5): кто и когда; при включении можно прислать
 *   пропущенных за время выключения (не старше 7 суток).
 *
 * «Кто и когда» — в строках настроек; повторное нажатие их не переписывает.
 */

const MARKET_LABELS: Record<string, string> = { ru: 'РФ', us: 'США' };
const OPEN_PAUSES_SHOWN = 50;
const RESUME_BATCH = 200;
const MISSED_LEADS_DAYS = 7;
export const VE_SENDER_NOTE_MAX = 300;

export type VeSenderMarket = 'ru' | 'us';

export interface VeSenderMarketSwitch {
  market: string;
  label: string;
  mode: string;
  mode_before_stop: 'pilot' | 'sender' | null;
  sender_uploads_enabled: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
  note: string | null;
  /** Идущие запуски автоаутрича рынка: смена режима остановит их ещё не созданные гипотезы. */
  inflight_outreach_runs: number | null;
}

export interface VeSenderOpenPause {
  pause_id: string;
  campaign_id: string;
  campaign_name: string | null;
  action: 'paused' | 'unscheduled';
  paused_at: string;
}

export interface VeSenderSwitchState {
  /** null — не прочиталось. */
  markets: VeSenderMarketSwitch[] | null;
  /** Запасной выключатель в настройках портала (VE2_SENDER_LAUNCHES_DISABLED). */
  env_kill: boolean;
  sending: {
    enabled: boolean;
    changed_at: string | null;
    changed_by_name: string | null;
    note: string | null;
    running_campaigns: number | null;
    open_pauses: VeSenderOpenPause[];
    open_pauses_total: number;
  } | null;
  lead_cards: {
    enabled: boolean;
    enabled_at: string | null;
    disabled_at: string | null;
    changed_by_name: string | null;
    note: string | null;
    /** Лиды проектов Движка без карточки, оценённые за время выключения (пока выключено). */
    missed_leads: number | null;
  } | null;
}

export interface VeSenderSwitchResult {
  changed: boolean;
  lines: string[];
}

export function cleanVeSenderNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed ? trimmed.slice(0, VE_SENDER_NOTE_MAX) : null;
}

function marketLabel(market: string): string {
  return MARKET_LABELS[market] ?? market.toUpperCase();
}

async function profileNames(db: SupabaseClient, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (!unique.length) return names;
  const { data } = await db.from('profiles').select('id, full_name, email').in('id', unique);
  for (const row of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    names.set(row.id, row.full_name?.trim() || row.email || 'сотрудник');
  }
  return names;
}

async function countRows(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count, error } = await query;
  return error ? null : count ?? 0;
}

async function readMarkets(db: SupabaseClient): Promise<VeSenderMarketSwitch[] | null> {
  const { data, error } = await db.from('ve_launch_transport_settings')
    .select('market, mode, mode_before_stop, sender_uploads_enabled, updated_at, updated_by, note');
  if (error) return null;
  const rows = (data ?? []) as Array<{
    market: string; mode: string; mode_before_stop: string | null; sender_uploads_enabled: boolean;
    updated_at: string | null; updated_by: string | null; note: string | null;
  }>;
  const names = await profileNames(db, rows.map((row) => row.updated_by));
  // Идущие запуски автоаутрича — по проектам рынка.
  const runs = new Map<string, number | null>();
  const { data: active, error: runsError } = await db.from('ve_outreach_runs')
    .select('project_id').in('status', ['queued', 'running', 'waiting']);
  if (runsError) {
    for (const row of rows) runs.set(row.market, null);
  } else {
    const projectIds = [...new Set(((active ?? []) as Array<{ project_id: string }>).map((row) => row.project_id))];
    const marketOf = new Map<string, string>();
    if (projectIds.length) {
      const { data: projects, error: projectsError } = await db.from('ve_projects').select('id, market').in('id', projectIds);
      if (projectsError) for (const row of rows) runs.set(row.market, null);
      for (const project of (projects ?? []) as Array<{ id: string; market: string | null }>) marketOf.set(project.id, project.market ?? 'ru');
    }
    for (const row of rows) {
      if (runs.has(row.market)) continue;
      runs.set(row.market, ((active ?? []) as Array<{ project_id: string }>).filter((run) => (marketOf.get(run.project_id) ?? 'ru') === row.market).length);
    }
  }
  return rows
    .map((row): VeSenderMarketSwitch => ({
      market: row.market,
      label: marketLabel(row.market),
      mode: row.mode,
      mode_before_stop: row.mode_before_stop === 'pilot' || row.mode_before_stop === 'sender' ? row.mode_before_stop : null,
      sender_uploads_enabled: row.sender_uploads_enabled === true,
      updated_at: row.updated_at,
      updated_by_name: row.updated_by ? names.get(row.updated_by) ?? null : null,
      note: row.note,
      inflight_outreach_runs: runs.get(row.market) ?? null,
    }))
    .sort((left, right) => left.market.localeCompare(right.market));
}

async function readSending(db: SupabaseClient): Promise<VeSenderSwitchState['sending']> {
  const { data, error } = await db.from('ve_sender_global_settings')
    .select('sending_enabled, sending_changed_at, sending_changed_by, sending_note').eq('id', true).maybeSingle();
  if (error) return null;
  const row = data as { sending_enabled: boolean; sending_changed_at: string | null; sending_changed_by: string | null; sending_note: string | null } | null;
  const { data: pauses, error: pausesError, count } = await db.from('ve_sender_sending_pauses')
    .select('id, campaign_id, action, paused_at', { count: 'exact' })
    .is('resumed_at', null).order('created_at', { ascending: true }).limit(OPEN_PAUSES_SHOWN);
  if (pausesError) return null;
  const open = (pauses ?? []) as Array<{ id: string; campaign_id: string; action: 'paused' | 'unscheduled'; paused_at: string }>;
  const campaignNames = new Map<string, string | null>();
  if (open.length) {
    const { data: campaigns } = await db.from('sender_campaigns').select('id, name').in('id', [...new Set(open.map((pause) => pause.campaign_id))]);
    for (const campaign of (campaigns ?? []) as Array<{ id: string; name: string | null }>) campaignNames.set(campaign.id, campaign.name);
  }
  const names = await profileNames(db, [row?.sending_changed_by]);
  const running = await countRows(db.from('sender_campaigns').select('id', { count: 'exact', head: true }).eq('source_kind', 've2').eq('status', 'running'));
  return {
    enabled: row?.sending_enabled !== false,
    changed_at: row?.sending_changed_at ?? null,
    changed_by_name: row?.sending_changed_by ? names.get(row.sending_changed_by) ?? null : null,
    note: row?.sending_note ?? null,
    running_campaigns: running,
    open_pauses: open.map((pause) => ({
      pause_id: pause.id,
      campaign_id: pause.campaign_id,
      campaign_name: campaignNames.get(pause.campaign_id) ?? null,
      action: pause.action,
      paused_at: pause.paused_at,
    })),
    open_pauses_total: count ?? open.length,
  };
}

/** Лиды проектов Движка, оценённые не раньше since, у которых нет карточки. Списки id — порциями: длинный адрес шлюз не пропустит. */
async function countMissedLeads(db: SupabaseClient, since: string): Promise<number | null> {
  const { data: campaigns, error } = await db.from('sender_campaigns').select('id').eq('source_kind', 've2').not('project_id', 'is', null);
  if (error) return null;
  const ids = ((campaigns ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (!ids.length) return 0;
  const recipients = new Set<string>();
  for (const chunk of chunkForInFilter(ids)) {
    const { data: leads, error: leadsError } = await db.from('sender_reply_qualifications')
      .select('recipient_id').eq('status', 'lead').gte('qualified_at', since).in('campaign_id', chunk).limit(1000);
    if (leadsError) return null;
    for (const row of (leads ?? []) as Array<{ recipient_id: string }>) recipients.add(row.recipient_id);
  }
  if (!recipients.size) return 0;
  const carded = new Set<string>();
  for (const chunk of chunkForInFilter([...recipients])) {
    const { data: cards, error: cardsError } = await db.from('sender_project_lead_cards').select('recipient_id').in('recipient_id', chunk);
    if (cardsError) return null;
    for (const row of (cards ?? []) as Array<{ recipient_id: string }>) carded.add(row.recipient_id);
  }
  return [...recipients].filter((id) => !carded.has(id)).length;
}

/**
 * С какого момента лиды считаются пропущенными: отсечка, что действовала до
 * выключения (enabled_at; выключение её не трогает), но не дальше 7 суток.
 * Лиды, оценённые прямо перед выключением и ещё не получившие карточку, тоже
 * пропущенные.
 */
function missedSince(enabledAt: string | null, now: Date): string {
  const floor = now.getTime() - MISSED_LEADS_DAYS * 24 * 60 * 60_000;
  const cutoff = enabledAt ? Date.parse(enabledAt) : NaN;
  return new Date(Number.isFinite(cutoff) ? Math.max(cutoff, floor) : floor).toISOString();
}

async function readLeadCards(db: SupabaseClient, now: Date): Promise<VeSenderSwitchState['lead_cards']> {
  const { data, error } = await db.from('sender_project_lead_settings')
    .select('enabled, enabled_at, disabled_at, updated_by, note').eq('id', true).maybeSingle();
  if (error) return null;
  const row = data as { enabled: boolean; enabled_at: string | null; disabled_at: string | null; updated_by: string | null; note: string | null } | null;
  if (!row) return null;
  const names = await profileNames(db, [row.updated_by]);
  return {
    enabled: row.enabled !== false,
    enabled_at: row.enabled_at,
    disabled_at: row.disabled_at,
    changed_by_name: row.updated_by ? names.get(row.updated_by) ?? null : null,
    note: row.note,
    missed_leads: row.enabled === false ? await countMissedLeads(db, missedSince(row.enabled_at, now)) : 0,
  };
}

/** Всё, что видит панель. Каждая часть читается отдельно: сбой одной — null, панель остаётся. */
export async function readVeSenderSwitchState(
  db: SupabaseClient,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<VeSenderSwitchState> {
  const safe = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  const [markets, sending, leadCards] = await Promise.all([
    safe(() => readMarkets(db)),
    safe(() => readSending(db)),
    safe(() => readLeadCards(db, now)),
  ]);
  return { markets, env_kill: killedByEnv(env), sending, lead_cards: leadCards };
}

// ─── Новые запуски ─────────────────────────────────────────────────────────

async function readMarketRow(db: SupabaseClient, market: VeSenderMarket) {
  const { data, error } = await db.from('ve_launch_transport_settings')
    .select('market, mode, mode_before_stop, sender_uploads_enabled').eq('market', market).maybeSingle();
  if (error) throw new SenderOpError(`Настройки рынка не прочитались: ${error.message}`, 500);
  if (!data) throw new SenderOpError('Нет настроек рынка — нужна миграция 20261024_0020', 409);
  return data as { market: string; mode: string; mode_before_stop: string | null; sender_uploads_enabled: boolean };
}

export async function stopVeLaunches(
  db: SupabaseClient,
  input: { market: VeSenderMarket; userId: string | null; note: string | null; now?: Date },
): Promise<VeSenderSwitchResult> {
  const label = marketLabel(input.market);
  const row = await readMarketRow(db, input.market);
  if (row.mode === 'instantly') return { changed: false, lines: [`${label}: новые запуски уже идут только в Instantly.`] };
  const { data, error } = await db.from('ve_launch_transport_settings')
    .update({
      mode: 'instantly',
      mode_before_stop: row.mode === 'pilot' || row.mode === 'sender' ? row.mode : null,
      updated_at: (input.now ?? new Date()).toISOString(),
      updated_by: input.userId,
      note: input.note,
    })
    .eq('market', input.market).eq('mode', row.mode).select('market');
  if (error) throw new SenderOpError(`Не записалось: ${error.message}`, 500);
  if (!data?.length) throw new SenderOpError('Режим рынка только что поменяли — обновите панель', 409);
  return { changed: true, lines: [`${label}: новые запуски идут только в Instantly.`] };
}

export async function restoreVeLaunches(
  db: SupabaseClient,
  input: { market: VeSenderMarket; userId: string | null; note: string | null; now?: Date },
): Promise<VeSenderSwitchResult> {
  const label = marketLabel(input.market);
  const row = await readMarketRow(db, input.market);
  const before = row.mode_before_stop;
  if (row.mode !== 'instantly' || (before !== 'pilot' && before !== 'sender')) {
    return { changed: false, lines: [`${label}: возвращать нечего — запуски не выключались этой панелью.`] };
  }
  const { data, error } = await db.from('ve_launch_transport_settings')
    .update({ mode: before, mode_before_stop: null, updated_at: (input.now ?? new Date()).toISOString(), updated_by: input.userId, note: input.note })
    .eq('market', input.market).eq('mode', 'instantly').eq('mode_before_stop', before).select('market');
  if (error) throw new SenderOpError(`Не записалось: ${error.message}`, 500);
  if (!data?.length) throw new SenderOpError('Режим рынка только что поменяли — обновите панель', 409);
  return { changed: true, lines: [`${label}: новые запуски снова идут как было — ${before === 'pilot' ? 'пилот' : 'в «Рассылку»'}.`] };
}

// ─── Подача контактов ──────────────────────────────────────────────────────

export async function setVeSenderUploads(
  db: SupabaseClient,
  input: { market: VeSenderMarket; enabled: boolean; userId: string | null; note: string | null; now?: Date },
): Promise<VeSenderSwitchResult> {
  const label = marketLabel(input.market);
  const { data, error } = await db.from('ve_launch_transport_settings')
    .update({ sender_uploads_enabled: input.enabled, updated_at: (input.now ?? new Date()).toISOString(), updated_by: input.userId, note: input.note })
    .eq('market', input.market).eq('sender_uploads_enabled', !input.enabled).select('market');
  if (error) throw new SenderOpError(`Не записалось: ${error.message}`, 500);
  if (!data?.length) {
    await readMarketRow(db, input.market);
    return { changed: false, lines: [`${label}: подача контактов в «Рассылку» уже ${input.enabled ? 'включена' : 'выключена'}.`] };
  }
  return { changed: true, lines: [`${label}: подача контактов в «Рассылку» ${input.enabled ? 'включена' : 'выключена'}.`] };
}

// ─── Карточки лидов ────────────────────────────────────────────────────────

export async function setProjectLeadCards(
  db: SupabaseClient,
  input: { enabled: boolean; includeMissed?: boolean; userId: string | null; note: string | null; now?: Date },
): Promise<VeSenderSwitchResult> {
  const now = input.now ?? new Date();
  if (!input.enabled) {
    const { data, error } = await db.from('sender_project_lead_settings')
      .update({ enabled: false, disabled_at: now.toISOString(), updated_by: input.userId, note: input.note })
      .eq('id', true).eq('enabled', true).select('id');
    if (error) throw new SenderOpError(`Не записалось: ${error.message}`, 500);
    return data?.length
      ? { changed: true, lines: ['Карточки лидов проектов Движка выключены.'] }
      : { changed: false, lines: ['Карточки лидов уже выключены.'] };
  }
  const { data: current, error: readError } = await db.from('sender_project_lead_settings')
    .select('enabled, enabled_at').eq('id', true).maybeSingle();
  if (readError) throw new SenderOpError(`Настройки карточек не прочитались: ${readError.message}`, 500);
  if (!current) throw new SenderOpError('Нет настроек карточек — нужна миграция 20261026_0010', 409);
  const row = current as { enabled: boolean; enabled_at: string | null };
  if (row.enabled) return { changed: false, lines: ['Карточки лидов уже включены.'] };
  const since = missedSince(row.enabled_at, now);
  const missed = input.includeMissed ? await countMissedLeads(db, since) : null;
  const { data, error } = await db.from('sender_project_lead_settings')
    .update({ enabled: true, updated_by: input.userId, note: input.note })
    .eq('id', true).eq('enabled', false).select('id');
  if (error) throw new SenderOpError(`Не записалось: ${error.message}`, 500);
  if (!data?.length) return { changed: false, lines: ['Карточки лидов уже включены.'] };
  if (!input.includeMissed) return { changed: true, lines: ['Карточки лидов включены — придут только новые лиды.'] };
  // Триггер включения ставит enabled_at = сейчас; возвращаем отсечку, что была до выключения (не дальше 7 суток).
  const { error: cutoffError } = await db.from('sender_project_lead_settings')
    .update({ enabled_at: since }).eq('id', true).eq('enabled', true);
  if (cutoffError) {
    return { changed: true, lines: ['Карточки лидов включены, но пропущенных прислать не вышло — придут только новые.', `Причина: ${cutoffError.message}`] };
  }
  return {
    changed: true,
    lines: [`Карточки лидов включены. Пропущенные за время выключения придут карточками${missed != null ? `: ${missed}` : ''} (по 10 в минуту).`],
  };
}

// ─── Отправка кампаний Движка ──────────────────────────────────────────────

interface PauseRunningReport {
  paused: number;
  unscheduled: number;
  canceled_messages: number;
  still_running: number;
}

async function pauseRunning(db: SupabaseClient, note: string | null): Promise<PauseRunningReport> {
  const { data, error } = await db.rpc('ve_sender_pause_running', { p_note: note });
  if (error) throw new SenderOpError(`Пауза кампаний не прошла: ${error.message}`, 500);
  const row = (data ?? {}) as Partial<PauseRunningReport>;
  return {
    paused: Number(row.paused ?? 0),
    unscheduled: Number(row.unscheduled ?? 0),
    canceled_messages: Number(row.canceled_messages ?? 0),
    still_running: Number(row.still_running ?? 0),
  };
}

export async function stopVeSenderSending(
  db: SupabaseClient,
  input: { userId: string | null; note: string | null; now?: Date },
): Promise<VeSenderSwitchResult & { still_running: number }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  // Шаг 1 — флаг, своей транзакцией: дальше любой запуск кампании Движка отказывает.
  const { data: flipped, error } = await db.from('ve_sender_global_settings')
    .update({ sending_enabled: false, sending_changed_at: nowIso, sending_changed_by: input.userId, sending_note: input.note, updated_at: nowIso })
    .eq('id', true).eq('sending_enabled', true).select('id');
  if (error) throw new SenderOpError(`Выключатель не записался: ${error.message}`, 500);
  let alreadyStopped = !flipped?.length;
  if (alreadyStopped) {
    const { data: row, error: readError } = await db.from('ve_sender_global_settings').select('sending_enabled').eq('id', true).maybeSingle();
    if (readError) throw new SenderOpError(`Выключатель не прочитался: ${readError.message}`, 500);
    if (!row) {
      const { error: insertError } = await db.from('ve_sender_global_settings').insert({
        id: true, sending_enabled: false, sending_changed_at: nowIso, sending_changed_by: input.userId, sending_note: input.note, updated_at: nowIso,
      });
      if (insertError) throw new SenderOpError(`Выключатель не записался: ${insertError.message}`, 500);
      alreadyStopped = false;
    } else if ((row as { sending_enabled: boolean }).sending_enabled !== false) {
      throw new SenderOpError('Выключатель только что поменяли — обновите панель', 409);
    }
  }
  // Шаг 2 — пауза идущих и снятие назначенных; не всё встало — ещё раз.
  let report = await pauseRunning(db, input.note);
  const total = { ...report };
  if (report.still_running > 0) {
    report = await pauseRunning(db, input.note);
    total.paused += report.paused;
    total.unscheduled += report.unscheduled;
    total.canceled_messages += report.canceled_messages;
    total.still_running = report.still_running;
  }
  const lines = [
    alreadyStopped ? 'Отправка кампаний Движка уже была остановлена — остановили ещё раз.' : 'Отправка кампаний Движка остановлена.',
    `На паузу: ${total.paused}, снято назначенных запусков: ${total.unscheduled}, снято писем из очереди: ${total.canceled_messages}.`,
  ];
  if (total.still_running > 0) lines.push(`Не все кампании встали: идёт ещё ${total.still_running} — нажмите «Остановить ещё раз».`);
  return { changed: !alreadyStopped || total.paused + total.unscheduled > 0, lines, still_running: total.still_running };
}

type ClaimResult = {
  claimed: boolean;
  action?: 'paused' | 'unscheduled';
  campaign_id?: string;
  campaign_status?: string | null;
  untouched?: boolean;
  active_recipients?: number;
};

async function finishPause(db: SupabaseClient, pauseId: string, mode: 'raw_running' | 'restore_schedule' | 'close', userId: string | null, result: string): Promise<'done' | 'skip'> {
  const { data, error } = await db.rpc('ve_sender_resume_finish', { p_pause_id: pauseId, p_mode: mode, p_user: userId, p_result: result });
  if (error) throw new Error(error.message);
  return data === 'done' ? 'done' : 'skip';
}

async function releasePause(db: SupabaseClient, pauseId: string): Promise<void> {
  await db.from('ve_sender_sending_pauses').update({ resume_claimed_until: null }).eq('id', pauseId).is('resumed_at', null);
}

/** Текст отказа для панели: сырые ошибки базы — только в журнал. */
function resumeRefusalText(error: SenderOpError): string {
  if (error.status < 500) return error.message;
  return error.message.startsWith('Стоп-листы клиента и проекта не сверены')
    ? 'стоп-листы клиента и проекта не сверены — повторите позже'
    : 'не удалось запустить — повторите';
}

const NO_RECIPIENTS = 'В кампании нет получателей';

export interface VeSenderResumeReport extends VeSenderSwitchResult {
  resumed: number;
  rescheduled: number;
  left_open: number;
  stopped_again: boolean;
  diagnostics: string[];
}

export async function resumeVeSenderSending(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  input: { userId: string | null; note: string | null; budgetMs?: number; now?: () => Date },
): Promise<VeSenderResumeReport> {
  const now = input.now ?? (() => new Date());
  const started = now().getTime();
  const budget = input.budgetMs ?? 45_000;
  const nowIso = now().toISOString();
  const { data: flipped, error } = await db.from('ve_sender_global_settings')
    .update({ sending_enabled: true, sending_changed_at: nowIso, sending_changed_by: input.userId, sending_note: input.note, updated_at: nowIso })
    .eq('id', true).eq('sending_enabled', false).select('id');
  if (error) throw new SenderOpError(`Выключатель не записался: ${error.message}`, 500);
  const flagChanged = Boolean(flipped?.length);

  const { data: open, error: openError } = await db.from('ve_sender_sending_pauses')
    .select('id, campaign_id, action').is('resumed_at', null).order('created_at', { ascending: true }).limit(RESUME_BATCH);
  if (openError) throw new SenderOpError(`Список остановленных не прочитался: ${openError.message}`, 500);
  const rows = (open ?? []) as Array<{ id: string; campaign_id: string; action: 'paused' | 'unscheduled' }>;
  const names = new Map<string, string>();
  if (rows.length) {
    const { data: campaigns } = await db.from('sender_campaigns').select('id, name').in('id', [...new Set(rows.map((row) => row.campaign_id))]);
    for (const campaign of (campaigns ?? []) as Array<{ id: string; name: string | null }>) names.set(campaign.id, campaign.name ?? campaign.id);
  }

  const report: VeSenderResumeReport = { changed: flagChanged, lines: [], resumed: 0, rescheduled: 0, left_open: 0, stopped_again: false, diagnostics: [] };
  const skipped: string[] = [];
  const waiting: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (now().getTime() - started > budget) {
      report.left_open += rows.length - index;
      break;
    }
    // Отправку снова остановили, пока шло продолжение, — остальное не трогаем.
    const flag = await readVe2SendingSwitch(db);
    if (flag.state !== 'enabled') {
      report.stopped_again = flag.state === 'stopped';
      report.left_open += rows.length - index;
      break;
    }
    const { data: claimData, error: claimError } = await db.rpc('ve_sender_resume_claim', { p_pause_id: row.id });
    if (claimError) {
      report.diagnostics.push(`${row.id}: ${claimError.message}`);
      report.left_open += 1;
      continue;
    }
    const claim = (claimData ?? { claimed: false }) as ClaimResult;
    if (!claim.claimed) continue;
    const name = `«${names.get(row.campaign_id) ?? row.campaign_id}»`;
    try {
      if (row.action === 'unscheduled') {
        if (await finishPause(db, row.id, 'restore_schedule', input.userId, 'назначенный запуск возвращён') === 'done') report.rescheduled += 1;
        else {
          await finishPause(db, row.id, 'close', input.userId, 'изменена после остановки — время запуска не возвращаем');
          skipped.push(`${name}: изменена после остановки — время запуска не возвращаем`);
        }
        continue;
      }
      if (claim.campaign_status === 'running') {
        await finishPause(db, row.id, 'close', input.userId, 'уже идёт');
        report.resumed += 1;
        continue;
      }
      if (claim.campaign_status !== 'paused' || !claim.untouched) {
        await finishPause(db, row.id, 'close', input.userId, 'изменена после остановки — не трогаем');
        skipped.push(`${name}: изменена после остановки — не трогаем`);
        continue;
      }
      try {
        await startCampaign(row.campaign_id, { instantlyDb });
        await finishPause(db, row.id, 'close', input.userId, 'запущена');
        report.resumed += 1;
      } catch (startError) {
        if (!(startError instanceof SenderOpError)) throw startError;
        if (startError.code === VE2_SENDING_STOPPED_CODE) {
          await releasePause(db, row.id);
          report.stopped_again = true;
          report.left_open += rows.length - index;
          break;
        }
        // И «нет получателей», и «всех закрыли стоп-листы» — людей в очереди не осталось.
        if (startError.status === 422 && startError.message.startsWith(NO_RECIPIENTS)) {
          // Между подачами получателей нет: такую startCampaign не запускает, а пауза после
          // активации не получает подачи — вернуть «идёт» напрямую, если людей правда нет.
          if (await finishPause(db, row.id, 'raw_running', input.userId, 'идёт — получателей пока нет') === 'done') report.resumed += 1;
          else {
            await releasePause(db, row.id);
            report.left_open += 1;
            waiting.push(`${name}: не запустилась — повторите`);
          }
          continue;
        }
        if (startError.status === 422 && /ящик/i.test(startError.message)) {
          await releasePause(db, row.id);
          report.left_open += 1;
          waiting.push(`${name}: ждёт рабочих ящиков`);
          continue;
        }
        if (startError.status >= 500) {
          report.diagnostics.push(`${row.campaign_id}: ${startError.message}`);
          await releasePause(db, row.id);
          report.left_open += 1;
          waiting.push(`${name}: ${resumeRefusalText(startError)}`);
          continue;
        }
        await finishPause(db, row.id, 'close', input.userId, resumeRefusalText(startError));
        skipped.push(`${name}: ${resumeRefusalText(startError)}`);
      }
    } catch (unexpected) {
      report.diagnostics.push(`${row.campaign_id}: ${unexpected instanceof Error ? unexpected.message : String(unexpected)}`);
      await releasePause(db, row.id).catch(() => undefined);
      report.left_open += 1;
      waiting.push(`${name}: не удалось — повторите`);
    }
  }

  report.lines.push(flagChanged ? 'Отправка кампаний Движка снова разрешена.' : 'Отправка кампаний Движка уже была разрешена.');
  report.lines.push(`Запущено снова: ${report.resumed}, возвращено назначенных запусков: ${report.rescheduled}.`);
  if (skipped.length) report.lines.push(`Не трогали: ${skipped.slice(0, 10).join('; ')}${skipped.length > 10 ? ` и ещё ${skipped.length - 10}` : ''}.`);
  if (waiting.length) report.lines.push(`Ждут: ${waiting.slice(0, 10).join('; ')}${waiting.length > 10 ? ` и ещё ${waiting.length - 10}` : ''}.`);
  if (report.stopped_again) report.lines.push('Отправку снова остановили, пока шло продолжение, — остальные кампании остались на паузе.');
  else if (report.left_open > 0) report.lines.push(`Осталось на паузе: ${report.left_open} — нажмите «Продолжить отправку» ещё раз.`);
  return report;
}

export async function keepVeCampaignPaused(
  db: SupabaseClient,
  input: { pauseId: string; userId: string | null },
): Promise<VeSenderSwitchResult> {
  // Та же строка, что занимает «Продолжить отправку»: пока продолжение запускает
  // эту кампанию, «Оставить на паузе» не обещает того, что уже не выполнить.
  const { data: claimData, error: claimError } = await db.rpc('ve_sender_resume_claim', { p_pause_id: input.pauseId });
  if (claimError) throw new SenderOpError(`Остановка не прочиталась: ${claimError.message}`, 500);
  const claim = (claimData ?? { claimed: false }) as ClaimResult;
  if (!claim.claimed) {
    const { data: row, error } = await db.from('ve_sender_sending_pauses').select('resumed_at').eq('id', input.pauseId).maybeSingle();
    if (error) throw new SenderOpError(`Остановка не прочиталась: ${error.message}`, 500);
    if (!row || (row as { resumed_at: string | null }).resumed_at) return { changed: false, lines: ['Эту остановку уже закрыли.'] };
    return { changed: false, lines: ['Эту кампанию сейчас продолжает «Продолжить отправку» — обновите панель через минуту.'] };
  }
  if (claim.action === 'paused' && claim.campaign_status === 'running') {
    await finishPause(db, input.pauseId, 'close', input.userId, 'уже идёт');
    return { changed: false, lines: ['Кампания уже идёт — поставить её на паузу можно в «Рассылке».'] };
  }
  await finishPause(db, input.pauseId, 'close', input.userId, 'оставлена на паузе');
  return {
    changed: true,
    lines: [claim.action === 'unscheduled'
      ? 'Назначенный запуск не вернётся: «Продолжить отправку» его не восстановит.'
      : 'Кампания останется на паузе: «Продолжить отправку» её не запустит.'],
  };
}
