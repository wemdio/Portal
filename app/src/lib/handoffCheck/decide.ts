/**
 * Что делать с сообщением о передаче проекта после очередной проверки карточки
 * (спека `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md`, §4-9,
 * план Task 5). Чистые функции: по сохранённой строке и результату проверки
 * решают, какой ответ отправить и какой статус записать. Ввод-вывод — в
 * `app/worker/handoffCheckBot.ts`.
 *
 * Главное правило: бот говорит только о проблемах. Единственный «позитивный»
 * ответ — «✅ Карточка дозаполнена», и только если в чате висит наше
 * предупреждение (`reply_message_id` не пуст). Проблема `AMO_UNAVAILABLE` в чат
 * не уходит никогда: такая строка ждёт ежедневной перепроверки.
 */
import type { Problem } from './checkCard';
import type { HandoffCheckRow, HandoffCheckStatus } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Напоминание — одно, не раньше чем через 3 дня после первого предупреждения в чате. */
export const REMINDER_AFTER_MS = 3 * DAY_MS;
/** Через 14 дней после первой проверки перестаём проверять. */
export const EXPIRE_AFTER_MS = 14 * DAY_MS;

/** Москва живёт в UTC+3 без перехода на летнее время (с 2014 года). */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAILY_PASS_HOUR_MSK = 10;

/**
 * `reply_message_id` на время отправки: строка сохраняется ДО ответа, чтобы
 * после падения процесса между отправкой и записью повтор не ответил дважды.
 * Для решений 0 значит «предупреждение в чате есть» (id неизвестен).
 */
export const REPLY_PENDING = 0;

export const AMO_UNAVAILABLE_PROBLEM: Problem = {
  code: 'AMO_UNAVAILABLE',
  text: 'не удалось прочитать сделку из AMO',
};

export type CheckOutcome =
  | { kind: 'no_link' }
  | { kind: 'amo_unavailable' }
  | { kind: 'checked'; problems: Problem[] };

/** `message` — новое или исправленное сообщение; `daily` — ежедневная перепроверка. */
export type Trigger = 'message' | 'daily';

export type ReplyKind = 'problems' | 'no_link' | 'resolved' | 'reminder';

export type PrevState = Pick<
  HandoffCheckRow,
  'status' | 'problems' | 'reply_message_id' | 'warned_at' | 'first_checked_at' | 'reminded_at' | 'resolved_at'
>;

export interface Decision {
  status: HandoffCheckStatus;
  problems: Problem[];
  reply: ReplyKind | null;
  /**
   * `reply_message_id` — id нашего предупреждения, которое сейчас висит в чате.
   * keep — не менять; clear — предупреждение снято; new — id только что
   * отправленного ответа.
   */
  replyMessageId: 'keep' | 'clear' | 'new';
  markReminded: boolean;
  markResolved: boolean;
}

/** Что сейчас «знает» чат о сообщении по нашему последнему предупреждению. */
type Told =
  | { kind: 'none' }
  | { kind: 'no_link' }
  | { kind: 'problems'; signature: string }
  /** Предупреждение висит, но о чём — неизвестно (после него AMO был недоступен). */
  | { kind: 'unknown' };

/** Проблемы, которые можно показать в чате: без `AMO_UNAVAILABLE`. */
export function chatVisibleProblems(problems: Problem[]): Problem[] {
  return problems.filter((problem) => problem.code !== 'AMO_UNAVAILABLE');
}

/**
 * Набор кодов проблем без учёта порядка — чтобы не повторять ответ на такую же
 * правку. Тексты не сравниваем: в них меняющиеся значения (суммы, этапы).
 */
export function problemsSignature(problems: Problem[]): string {
  return [...new Set(chatVisibleProblems(problems).map((problem) => problem.code))].sort().join(',');
}

function toldState(prev: PrevState | null): Told {
  if (!prev || prev.reply_message_id == null) return { kind: 'none' };
  if (prev.status === 'no_link') return { kind: 'no_link' };
  if (prev.status === 'problems' || prev.status === 'expired') {
    const signature = problemsSignature(prev.problems ?? []);
    return signature ? { kind: 'problems', signature } : { kind: 'unknown' };
  }
  return { kind: 'none' };
}

export function isExpired(prev: PrevState, now: Date): boolean {
  return now.getTime() - Date.parse(prev.first_checked_at) > EXPIRE_AFTER_MS;
}

function isReminderDue(prev: PrevState | null, now: Date): boolean {
  if (!prev || prev.reply_message_id == null || prev.reminded_at || !prev.warned_at) return false;
  return now.getTime() - Date.parse(prev.warned_at) >= REMINDER_AFTER_MS;
}

const SILENT = { reply: null, markReminded: false, markResolved: false } as const;

function decideNoLink(told: Told): Decision {
  if (told.kind === 'no_link') {
    return { ...SILENT, status: 'no_link', problems: [], replyMessageId: 'keep' };
  }
  return { ...SILENT, status: 'no_link', problems: [], reply: 'no_link', replyMessageId: 'new' };
}

function decideAmoUnavailable(prev: PrevState | null): Decision {
  // Предупреждение о проблемах уже висит — оставляем его как есть и ждём
  // ежедневной перепроверки: в чат про недоступность AMO не пишем.
  if (prev && prev.reply_message_id != null && (prev.status === 'problems' || prev.status === 'expired')) {
    return { ...SILENT, status: prev.status, problems: prev.problems ?? [], replyMessageId: 'keep' };
  }
  return { ...SILENT, status: 'problems', problems: [AMO_UNAVAILABLE_PROBLEM], replyMessageId: 'keep' };
}

function decideClean(prev: PrevState | null, told: Told): Decision {
  if (told.kind === 'none') {
    const status = prev?.status === 'resolved' ? 'resolved' : 'ok';
    return { ...SILENT, status, problems: [], replyMessageId: 'clear' };
  }
  return { ...SILENT, status: 'resolved', problems: [], reply: 'resolved', replyMessageId: 'clear', markResolved: true };
}

function decideProblems(
  prev: PrevState | null,
  told: Told,
  problems: Problem[],
  trigger: Trigger,
  now: Date,
): Decision {
  const alreadyTold = told.kind === 'problems' && told.signature === problemsSignature(problems);
  const warn: Decision = { ...SILENT, status: 'problems', problems, reply: 'problems', replyMessageId: 'new' };

  if (trigger === 'message') {
    return alreadyTold ? { ...SILENT, status: 'problems', problems, replyMessageId: 'keep' } : warn;
  }

  // Ежедневный проход: о проблемах ещё не говорили (AMO был недоступен) — говорим.
  if (told.kind !== 'problems') return warn;
  if (isReminderDue(prev, now)) {
    return { ...SILENT, status: 'problems', problems, reply: 'reminder', replyMessageId: 'keep', markReminded: true };
  }
  // Молчим до напоминания; в строке остаётся то, что сказано в чате.
  return { ...SILENT, status: 'problems', problems: prev?.problems ?? problems, replyMessageId: 'keep' };
}

export function decide(
  prev: PrevState | null,
  outcome: CheckOutcome,
  trigger: Trigger,
  now: Date,
): Decision {
  const told = toldState(prev);
  if (outcome.kind === 'no_link') return decideNoLink(told);
  if (outcome.kind === 'amo_unavailable') return decideAmoUnavailable(prev);
  const visible = chatVisibleProblems(outcome.problems);
  if (visible.length === 0) return decideClean(prev, told);
  return decideProblems(prev, told, visible, trigger, now);
}

/** Дата по Москве `YYYY-MM-DD` — ключ ежедневного прохода. */
export function moscowDateKey(now: Date): string {
  return new Date(now.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Момент сегодняшнего ежедневного прохода (10:00 МСК) в UTC. */
export function todayDailyPassStart(now: Date): Date {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const startUtcMs =
    Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), DAILY_PASS_HOUR_MSK) - MSK_OFFSET_MS;
  return new Date(startUtcMs);
}

/** Пора ли запускать ежедневный проход: уже 10:00 МСК и сегодня его ещё не было. */
export function isDailyPassDue(now: Date, lastPassDateKey: string | null): boolean {
  return now >= todayDailyPassStart(now) && moscowDateKey(now) !== lastPassDateKey;
}
