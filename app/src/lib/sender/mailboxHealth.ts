/**
 * Оценка здоровья ящика «Рассылки» (15.10.2026) — наша, не Instantly.
 *
 * Считается по последним 14 дням из того, что у нас есть: сколько писем ушло,
 * сколько из этих писем вернулось отбойниками и сколько отправок упало с ошибкой.
 * Один отбой на исходное письмо; задержки и отчёты о чужих отправках исключены.
 *   100 − отбои (5% отбоев → −40, 10% → −80, потолок −80)
 *       − ошибки отправки (5% → −10, потолок −20);
 *   ящик со статусом входа «ошибка» — не выше 30.
 * Меньше MIN_SENT писем за окно — оценки нет: по малой выборке она врала бы.
 */

export const HEALTH_WINDOW_DAYS = 14;
export const MIN_SENT = 20;

export interface MailboxHealthInput {
  sent: number;
  bounced: number;
  failed: number;
  /** Статус входа ящика: 'failed' режет оценку. */
  status: string;
}

export interface MailboxHealth {
  /** 0–100; null — писем за окно слишком мало. */
  score: number | null;
  sent: number;
  bounced: number;
  failed: number;
}

export function mailboxHealth(input: MailboxHealthInput): MailboxHealth {
  const { sent, bounced, failed } = input;
  if (sent < MIN_SENT) return { score: null, sent, bounced, failed };
  const bounceRate = bounced / sent;
  const failRate = failed / (sent + failed);
  let score = 100 - Math.min(80, bounceRate * 800) - Math.min(20, failRate * 200);
  if (input.status === 'failed') score = Math.min(score, 30);
  return { score: Math.max(0, Math.min(100, Math.round(score))), sent, bounced, failed };
}
