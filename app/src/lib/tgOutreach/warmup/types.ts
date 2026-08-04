/**
 * Прогрев TG-аккаунтов: типы и константы кривой нагрузки.
 *
 * Числа ниже — оценка правдоподобия поведения, а не измеренные пороги Telegram
 * (их никто не публикует). Держим в константах с env-override, чтобы менять без
 * правки логики. Обоснование выбора — в спеке
 * docs/superpowers/specs/2026-08-03-tg-outreach-warmup-design.md.
 */

/**
 * За сколько дней нагрузка доходит от первого дня до потолка.
 *
 * Кривая привязана к календарю прогрева, а НЕ к выбранному числу дней. Раньше
 * она растягивалась под `days`, и прогрев на 4 дня выходил втрое агрессивнее
 * недельного: аккаунт получал 6 сообщений в первый день и 80 в четвёртый.
 * Просьба «поставить меньше дней» на деле означает «пусть суммарно уйдёт
 * меньше», а не «пусть разгон будет резче» — потолок для свежего номера один и
 * тот же независимо от того, сколько дней его греют.
 *
 * Теперь день N всегда даёт одну и ту же нагрузку, а `days` решает только, на
 * каком дне остановиться. Дни сверх RAMP_DAYS идут на потолке.
 */
export const RAMP_DAYS = Number(process.env.TG_WARMUP_RAMP_DAYS ?? '7');

/** Переписок на аккаунт в первый день прогрева. */
export const CONVERSATIONS_FIRST_DAY = Number(
  process.env.TG_WARMUP_CONVERSATIONS_FIRST_DAY ?? '2',
);

/** Потолок переписок на аккаунт в день — достигается на дне RAMP_DAYS. */
export const CONVERSATIONS_PEAK = Number(
  process.env.TG_WARMUP_CONVERSATIONS_PEAK ?? '8',
);

/** Сообщений в одной переписке в первый день. */
export const MESSAGES_FIRST_DAY = Number(process.env.TG_WARMUP_MESSAGES_FIRST_DAY ?? '3');

/** Потолок сообщений в одной переписке — достигается на дне RAMP_DAYS. */
export const MESSAGES_PEAK = Number(process.env.TG_WARMUP_MESSAGES_PEAK ?? '10');

/** Пауза между репликами внутри переписки, секунды. */
export const REPLY_DELAY_RANGE_SEC: [number, number] = [
  Number(process.env.TG_WARMUP_REPLY_DELAY_MIN_SEC ?? '20'),
  Number(process.env.TG_WARMUP_REPLY_DELAY_MAX_SEC ?? '90'),
];

/** Дней прогрева по умолчанию. */
export const DEFAULT_WARMUP_DAYS = Number(process.env.TG_WARMUP_DEFAULT_DAYS ?? '4');

/**
 * Через сколько минут переписка, застрявшая в running, считается брошенной и
 * возвращается в очередь. Переписка из 10 реплик с паузами до 90с укладывается
 * в ~15 минут; берём тройной запас, чтобы не подхватить ту, что реально идёт.
 */
export const CONVERSATION_STALE_MINUTES = Number(
  process.env.TG_WARMUP_CONVERSATION_STALE_MIN ?? '45',
);

export type WarmupRunStatus = 'pending' | 'running' | 'finished' | 'stopped' | 'failed';
export type WarmupConversationStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WarmupPerAccountStat {
  account_id: string;
  session_name: string;
  done: number;
  failed: number;
  last_error: string | null;
}

export interface WarmupSummary {
  accounts_total: number;
  accounts_ok: number;
  accounts_failed: number;
  conversations_done: number;
  conversations_failed: number;
  messages_sent: number;
  per_account: WarmupPerAccountStat[];
}

export interface WarmupRun {
  id: string;
  campaign_id: string;
  days: number;
  status: WarmupRunStatus;
  current_day: number;
  started_at: string | null;
  finished_at: string | null;
  settings: Record<string, unknown>;
  summary: WarmupSummary | null;
  error_message: string | null;
  created_at: string;
}

export interface WarmupMessage {
  account_id: string;
  content: string;
  timestamp: string;
}

export interface WarmupLog {
  id: number;
  run_id: string;
  campaign_id: string;
  /** NULL = событие всего прогрева, иначе конкретного аккаунта. */
  account_id: string | null;
  level: 'info' | 'warning' | 'error';
  message: string;
  created_at: string;
}

export interface WarmupConversation {
  id: number;
  run_id: string;
  campaign_id: string;
  day_no: number;
  account_a_id: string;
  account_b_id: string;
  initiator_account_id: string;
  planned_at: string;
  planned_messages: number;
  status: WarmupConversationStatus;
  started_at: string | null;
  finished_at: string | null;
  messages: WarmupMessage[];
  error_reason: string | null;
}
