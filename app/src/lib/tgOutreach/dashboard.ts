/**
 * Сводка по кампании TG-аутрича: воронка, ряды графика, темп, остаток базы.
 *
 * Чистые функции над уже выбранными строками — выборка и рендер снаружи.
 *
 * Воронка намеренно считается теми же предикатами, что и отчёт по договору
 * (`report.ts`): `firstReplyAt` переиспользуется, а не переписывается. Два
 * экрана с разными числами про одно и то же хуже, чем отсутствие второго
 * экрана — оператор перестаёт доверять обоим.
 *
 * Прогрев сюда не попадает и попасть не может: он живёт в собственных таблицах
 * `tg_outreach_warmup_*` и в диалоги кампании не пишет. Фильтровать нечего.
 */
import { firstReplyAt, type ReportDialog } from './report';

/** Часовой пояс, в котором режем сутки. Тот же, что у отчёта. */
export const TZ_OFFSET_HOURS = 3;

const DAY_MS = 86_400_000;

export type DashboardPeriod = '1d' | '7d' | '30d' | 'all';

export const PERIOD_DAYS: Record<Exclude<DashboardPeriod, 'all'>, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
};

export interface DashboardContact {
  created_at: string | null;
  sent_at: string | null;
}

/** Диалог в том же виде, в каком его читает отчёт — предикаты общие. */
export type DashboardDialog = ReportDialog;

export interface DashboardForward {
  status: string;
  created_at: string | null;
}

export interface DashboardInput {
  contacts: DashboardContact[];
  dialogs: DashboardDialog[];
  forwards: DashboardForward[];
  period: DashboardPeriod;
  /** Момент отсчёта. Передаётся снаружи, чтобы функция осталась чистой. */
  now: number;
  tzOffsetHours?: number;
}

export interface FunnelStage {
  key: 'contacts' | 'delivered' | 'replies' | 'leads' | 'forwarded';
  name: string;
  value: number;
  /**
   * Доля от предыдущего шага, проценты с одним знаком. null — делить не на что.
   *
   * Ноль отправленных даёт прочерк, а не «0 %»: нулевая конверсия и отсутствие
   * рассылки читаются очень по-разному. То же правило, что уже действует в
   * отчёте по договору.
   */
  fromPrev: number | null;
}

export interface DashboardDay {
  /** Начало суток по местному времени, ISO. */
  date: string;
  delivered: number;
  replies: number;
  leads: number;
  blocks: number;
}

export interface DashboardPace {
  sentToday: number;
  sentYesterday: number;
  /** Среднесуточно за период, один знак после запятой. */
  perDay: number;
}

export interface DashboardBase {
  /** Контактов без отправки — сколько ещё есть кому писать. */
  remaining: number;
  /**
   * На сколько дней хватит при текущем среднесуточном темпе.
   * null — темп нулевой, делить не на что: «хватит навсегда» было бы враньём.
   */
  daysLeft: number | null;
}

export interface CampaignDashboard {
  from: string;
  to: string;
  funnel: FunnelStage[];
  blocks: number;
  days: DashboardDay[];
  pace: DashboardPace;
  base: DashboardBase;
}

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Начало местных суток, в которые попал момент. */
export function dayStart(atMs: number, tzOffsetHours: number): number {
  const offsetMs = tzOffsetHours * 3_600_000;
  return Math.floor((atMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
}

/**
 * Границы периода.
 *
 * Периоды режутся по суткам, а не «минус 168 часов от сейчас»: оператор,
 * спрашивающий «за неделю», имеет в виду календарные дни, и подвижная граница
 * заставляла бы одни и те же сутки то попадать в окно, то выпадать из него.
 *
 * `all` начинается с нуля эпохи — проще, чем искать самую раннюю строку, и
 * даёт тот же ответ.
 */
export function periodRange(
  period: DashboardPeriod,
  now: number,
  tzOffsetHours = TZ_OFFSET_HOURS,
): { fromMs: number; toMs: number } {
  const toMs = now;
  if (period === 'all') return { fromMs: 0, toMs };
  const today = dayStart(now, tzOffsetHours);
  return { fromMs: today - (PERIOD_DAYS[period] - 1) * DAY_MS, toMs };
}

function inRange(at: number | null, fromMs: number, toMs: number): boolean {
  return at !== null && at >= fromMs && at <= toMs;
}

/**
 * Момент целевого ответа. Как в отчёте: точки срабатывания триггера в базе нет,
 * поэтому берём последнее сообщение диалога, а если его нет — первый ответ.
 */
function leadAt(dialog: DashboardDialog): number | null {
  return ts(dialog.last_message_at) ?? firstReplyAt(dialog);
}

function share(value: number, base: number): number | null {
  if (base <= 0) return null;
  return Math.round((value / base) * 1000) / 10;
}

export function buildCampaignDashboard(input: DashboardInput): CampaignDashboard {
  const tz = input.tzOffsetHours ?? TZ_OFFSET_HOURS;
  const { fromMs, toMs } = periodRange(input.period, input.now, tz);

  const contacts = input.contacts.filter((c) => inRange(ts(c.created_at), fromMs, toMs)).length;
  const delivered = input.contacts.filter((c) => inRange(ts(c.sent_at), fromMs, toMs)).length;
  const replies = input.dialogs.filter((d) => inRange(firstReplyAt(d), fromMs, toMs)).length;
  const leads = input.dialogs
    .filter((d) => d.status === 'lead' && inRange(leadAt(d), fromMs, toMs)).length;
  // Сорвавшиеся передачи не считаем: до менеджера такой лид не дошёл.
  const forwarded = input.forwards
    .filter((f) => (f.status === 'pending' || f.status === 'sent')
      && inRange(ts(f.created_at), fromMs, toMs)).length;

  const blocks = input.dialogs
    .filter((d) => d.can_send_changed_reason === 'tg_user_blocked_bot'
      && inRange(ts(d.can_send_changed_at), fromMs, toMs)).length;

  const raw: Array<Omit<FunnelStage, 'fromPrev'>> = [
    { key: 'contacts', name: 'Контактов в базе', value: contacts },
    { key: 'delivered', name: 'Отправлено', value: delivered },
    { key: 'replies', name: 'Ответили', value: replies },
    { key: 'leads', name: 'Целевые', value: leads },
    { key: 'forwarded', name: 'Переданы менеджеру', value: forwarded },
  ];
  const funnel: FunnelStage[] = raw.map((stage, i) => ({
    ...stage,
    fromPrev: i === 0 ? null : share(stage.value, raw[i - 1].value),
  }));

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    funnel,
    blocks,
    days: buildDays(input, fromMs, toMs, tz),
    pace: buildPace(input, fromMs, toMs, tz),
    base: buildBase(input, fromMs, toMs, tz),
  };
}

/**
 * Ряды графика по суткам.
 *
 * Дни без событий обязаны присутствовать нулями: без них линия соединит
 * вторник с четвергом и покажет тренд, которого не было.
 *
 * Для «всего времени» начало берём по самой ранней строке, а не с эпохи —
 * иначе график начинался бы в 1970-м.
 */
function buildDays(
  input: DashboardInput,
  fromMs: number,
  toMs: number,
  tz: number,
): DashboardDay[] {
  const stamps: number[] = [];
  const push = (at: number | null) => {
    if (at !== null && at >= fromMs && at <= toMs) stamps.push(at);
  };
  for (const c of input.contacts) push(ts(c.sent_at));
  for (const d of input.dialogs) {
    push(firstReplyAt(d));
    if (d.status === 'lead') push(leadAt(d));
    if (d.can_send_changed_reason === 'tg_user_blocked_bot') push(ts(d.can_send_changed_at));
  }

  const lastDay = dayStart(toMs, tz);
  const firstDay = input.period === 'all'
    ? (stamps.length ? dayStart(Math.min(...stamps), tz) : lastDay)
    : dayStart(fromMs, tz);

  const slots = new Map<number, DashboardDay>();
  for (let d = firstDay; d <= lastDay; d += DAY_MS) {
    slots.set(d, { date: new Date(d).toISOString(), delivered: 0, replies: 0, leads: 0, blocks: 0 });
  }

  const bump = (at: number | null, field: keyof Omit<DashboardDay, 'date'>) => {
    if (at === null || at < fromMs || at > toMs) return;
    const slot = slots.get(dayStart(at, tz));
    if (slot) slot[field]++;
  };
  for (const c of input.contacts) bump(ts(c.sent_at), 'delivered');
  for (const d of input.dialogs) {
    bump(firstReplyAt(d), 'replies');
    if (d.status === 'lead') bump(leadAt(d), 'leads');
    if (d.can_send_changed_reason === 'tg_user_blocked_bot') bump(ts(d.can_send_changed_at), 'blocks');
  }

  return [...slots.values()];
}

function buildPace(
  input: DashboardInput,
  fromMs: number,
  toMs: number,
  tz: number,
): DashboardPace {
  const today = dayStart(toMs, tz);
  const yesterday = today - DAY_MS;
  let sentToday = 0;
  let sentYesterday = 0;
  let sentInPeriod = 0;

  for (const c of input.contacts) {
    const at = ts(c.sent_at);
    if (at === null) continue;
    const day = dayStart(at, tz);
    if (day === today) sentToday++;
    if (day === yesterday) sentYesterday++;
    if (at >= fromMs && at <= toMs) sentInPeriod++;
  }

  // Делим на прошедшие сутки периода, а не на его номинальную длину: за 30 дней
  // у кампании, живущей три дня, «среднесуточно» было бы занижено в десять раз.
  const spanDays = Math.max(Math.round((today - dayStart(fromMs, tz)) / DAY_MS) + 1, 1);
  return {
    sentToday,
    sentYesterday,
    perDay: Math.round((sentInPeriod / spanDays) * 10) / 10,
  };
}

function buildBase(
  input: DashboardInput,
  fromMs: number,
  toMs: number,
  tz: number,
): DashboardBase {
  const remaining = input.contacts.filter((c) => !c.sent_at).length;
  const { perDay } = buildPace(input, fromMs, toMs, tz);
  return {
    remaining,
    daysLeft: perDay > 0 ? Math.round((remaining / perDay) * 10) / 10 : null,
  };
}
