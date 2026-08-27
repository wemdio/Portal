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

/**
 * Диалог в том же виде, в каком его читает отчёт — предикаты общие. Плюс `id`:
 * он нужен, чтобы связать диалог с передачей менеджеру (у отчёта такой связи
 * нет, ему хватает счётчиков).
 */
export type DashboardDialog = ReportDialog & {
  id?: string | null;
  /**
   * Момент автоматической пересылки менеджеру по положительному триггеру.
   * Отдельной записи в очереди передач она не создаёт — только эту метку на
   * диалоге, и без неё воронка автопередачи не видит вовсе.
   */
  auto_forwarded_at?: string | null;
};

export interface DashboardForward {
  status: string;
  created_at: string | null;
  /** Диалог, который передавали. Нужен, чтобы не звать разобранное неразобранным. */
  dialog_id?: string | null;
}

export interface DashboardInput {
  contacts: DashboardContact[];
  dialogs: DashboardDialog[];
  forwards: DashboardForward[];
  period: DashboardPeriod;
  /**
   * Произвольный период, выбранный руками. Задан — побеждает `period`: пресет
   * в этом случае лишь подсвечивает кнопку в UI и на расчёт не влияет.
   */
  range?: { fromMs: number; toMs: number };
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
  /** Недоступны по технической причине, КРОМЕ блокировок: у тех своя цифра. */
  unreachable: number;
  /** Написали в периоде и до сих пор молчат. */
  awaiting: number;
  /** Ответили, но статус не проставлен и менеджеру не передали. */
  needsAttention: number;
  /**
   * Среднее время от нашего последнего сообщения до ответа, минуты.
   * null — в периоде никто не отвечал: ноль читался бы как «отвечают мгновенно».
   */
  avgReplyMinutes: number | null;
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

/**
 * Границы произвольного периода, выбранного оператором руками.
 *
 * Обе даты — `YYYY-MM-DD` и трактуются как календарные сутки МСК целиком: `from`
 * с начала своих суток, `to` — по конец своих. Так же, как режутся пресеты, и
 * это не косметика: иначе одна и та же дата давала бы разные цифры в
 * зависимости от того, выбрали её руками или пресетом. Верхняя граница
 * включительная — ровно то, что обещает подпись поля.
 *
 * `null` — некорректный ввод (не та форма, несуществующая дата, конец раньше
 * начала). Вызывающий обязан ответить ошибкой, а не молча показать пустой
 * период: пустая сводка и «вы ошиблись в дате» — разные сообщения.
 */
export function customRange(
  from: string,
  to: string,
  tzOffsetHours = TZ_OFFSET_HOURS,
): { fromMs: number; toMs: number } | null {
  const shape = /^\d{4}-\d{2}-\d{2}$/;
  if (!shape.test(from) || !shape.test(to)) return null;

  const offset = tzOffsetHours * 3_600_000;
  const fromUtc = Date.parse(`${from}T00:00:00.000Z`);
  const toUtc = Date.parse(`${to}T00:00:00.000Z`);
  // Date.parse отвергает 2026-13-99, но 2026-02-30 молча не существует —
  // проверять всё равно приходится обоими способами.
  if (!Number.isFinite(fromUtc) || !Number.isFinite(toUtc)) return null;

  const fromMs = fromUtc - offset;
  const toMs = toUtc - offset + DAY_MS - 1;
  if (toMs < fromMs) return null;
  return { fromMs, toMs };
}

/**
 * Причины технической недоступности, кроме блокировки.
 *
 * Блокировка сознательно не здесь: у неё отдельная плашка и отдельный смысл —
 * человек нас прочитал и закрылся, а это сигнал о темпе. Остальные причины
 * говорят лишь о том, что контакт мёртв, и складывать их в одну цифру значило
 * бы показать одного человека дважды в соседних числах.
 */
const UNREACHABLE_REASONS = new Set([
  'tg_user_deactivated',
  'tg_peer_invalid',
  'tg_user_banned_in_channel',
  'tg_unreachable',
]);

/** Момент первого нашего сообщения в диалоге. */
function firstOutgoingAt(dialog: DashboardDialog): number | null {
  for (const m of dialog.messages ?? []) {
    if (m?.role === 'assistant') {
      const t = ts(m.timestamp);
      if (t !== null) return t;
    }
  }
  return null;
}

/**
 * Наше последнее сообщение перед моментом `beforeMs`.
 *
 * Именно последнее, а не первое: в цепочке с догоняющими сообщениями человек
 * отвечает на то, что прочитал сейчас, и «время до ответа» осмысленно мерить
 * от него. От первого касания получилась бы длительность всей цепочки.
 */
function lastOutgoingBefore(dialog: DashboardDialog, beforeMs: number): number | null {
  let best: number | null = null;
  for (const m of dialog.messages ?? []) {
    if (m?.role !== 'assistant') continue;
    const t = ts(m.timestamp);
    if (t !== null && t < beforeMs && (best === null || t > best)) best = t;
  }
  return best;
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
  const { fromMs, toMs } = input.range ?? periodRange(input.period, input.now, tz);

  const contacts = input.contacts.filter((c) => inRange(ts(c.created_at), fromMs, toMs)).length;
  const delivered = input.contacts.filter((c) => inRange(ts(c.sent_at), fromMs, toMs)).length;
  const replies = input.dialogs.filter((d) => inRange(firstReplyAt(d), fromMs, toMs)).length;
  const leads = input.dialogs
    .filter((d) => d.status === 'lead' && inRange(leadAt(d), fromMs, toMs)).length;
  /**
   * Переданные менеджеру — и вручную, и автоматически.
   *
   * До 27.08.2026 ступень считала только очередь ручных передач
   * (`tg_outreach_lead_forwards`), а автопересылка по положительному триггеру
   * записи туда не делает — она ставит метку на самом диалоге. В итоге на ATOL
   * за неделю воронка показывала «Переданы менеджеру — 0», хотя в «Диалогах»
   * три человека стояли с плашкой «Ушёл менеджеру». Один и тот же факт брался
   * из двух разных мест, и одно из них экран не читал.
   *
   * Считаем по диалогам, а не по сумме двух счётчиков: на одном человеке может
   * быть и автопересылка, и досланная руками карточка, а менеджеру он ушёл
   * один раз. Сорвавшиеся передачи не в счёт — до менеджера такой лид не дошёл.
   */
  const forwardedDialogs = new Set<string>();
  let forwardedWithoutDialogId = 0;
  for (const f of input.forwards) {
    if (f.status !== 'pending' && f.status !== 'sent') continue;
    if (!inRange(ts(f.created_at), fromMs, toMs)) continue;
    if (f.dialog_id) forwardedDialogs.add(f.dialog_id);
    // Диалог могли удалить из портала — передача всё равно состоялась.
    else forwardedWithoutDialogId++;
  }
  for (const d of input.dialogs) {
    if (!inRange(ts(d.auto_forwarded_at), fromMs, toMs)) continue;
    if (d.id) forwardedDialogs.add(d.id);
    else forwardedWithoutDialogId++;
  }
  const forwarded = forwardedDialogs.size + forwardedWithoutDialogId;

  const blocks = input.dialogs
    .filter((d) => d.can_send_changed_reason === 'tg_user_blocked_bot'
      && inRange(ts(d.can_send_changed_at), fromMs, toMs)).length;

  const unreachable = input.dialogs
    .filter((d) => UNREACHABLE_REASONS.has(d.can_send_changed_reason ?? '')
      && inRange(ts(d.can_send_changed_at), fromMs, toMs)).length;

  // Молчание проверяем на «вообще ни разу», а не «не ответил в периоде»:
  // ответивший после конца окна уже не ждёт нашего внимания.
  const awaiting = input.dialogs
    .filter((d) => inRange(firstOutgoingAt(d), fromMs, toMs) && firstReplyAt(d) === null).length;

  /**
   * Сорвавшиеся передачи не снимают вопрос: до менеджера такой диалог не дошёл,
   * и разобрать его всё ещё некому.
   *
   * Автопересылка считается наравне с ручной и без ограничения периодом: если
   * человек ушёл менеджеру вчера, а ответил сегодня, внимания он уже не
   * требует — им занимаются.
   */
  const handedOver = new Set(
    input.forwards
      .filter((f) => (f.status === 'pending' || f.status === 'sent') && f.dialog_id)
      .map((f) => f.dialog_id as string),
  );
  for (const d of input.dialogs) {
    if (d.auto_forwarded_at && d.id) handedOver.add(d.id);
  }
  const needsAttention = input.dialogs
    .filter((d) => inRange(firstReplyAt(d), fromMs, toMs)
      && d.status === 'none'
      && !(d.id && handedOver.has(d.id))).length;

  const replyDelays: number[] = [];
  for (const d of input.dialogs) {
    const reply = firstReplyAt(d);
    if (!inRange(reply, fromMs, toMs)) continue;
    const out = lastOutgoingBefore(d, reply as number);
    // Человек написал первым — измерять нечего, и подставлять сюда ноль нельзя:
    // это исказило бы среднее в сторону «отвечают мгновенно».
    if (out === null) continue;
    replyDelays.push(((reply as number) - out) / 60_000);
  }
  const avgReplyMinutes = replyDelays.length
    ? Math.round(replyDelays.reduce((a, b) => a + b, 0) / replyDelays.length)
    : null;

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
    unreachable,
    awaiting,
    needsAttention,
    avgReplyMinutes,
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
