import type { SendErrorCode } from './smtp';

/**
 * Когда снова проверять вход в ящик (решение владельца 23.10.2026).
 *
 * Упавший ящик перепроверяется с нарастающей паузой: временный сбой
 * провайдера проходит за минуты, сменённый пароль не пройдёт и за неделю, а
 * частые неудачные входы сами вредят ящику. Первую паузу (15 минут) ставит
 * база при падении (триггер sender_mailboxes_failure_clock), дальше — эта
 * лестница. Через неделю автопроверка останавливается: дальше — кнопкой
 * «Проверить вход».
 */
export const RECHECK_DELAYS_MS = [
  15 * 60_000,
  60 * 60_000,
  3 * 3600_000,
  6 * 3600_000,
  12 * 3600_000,
];

export const STOP_RECHECK_AFTER_MS = 7 * 24 * 3600_000;

/** Время следующей перепроверки после attemptsDone неудачных; null — больше не проверяем. */
export function nextRecheckAt(attemptsDone: number, failedAt: string | null, now: number): string | null {
  const since = failedAt ? Date.parse(failedAt) : NaN;
  if (Number.isFinite(since) && now - since >= STOP_RECHECK_AFTER_MS) return null;
  const delay = RECHECK_DELAYS_MS[Math.min(Math.max(attemptsDone, 0), RECHECK_DELAYS_MS.length - 1)];
  return new Date(now + delay).toISOString();
}

/**
 * Сбои проверки, после которых ящик не объявляется сломанным: провайдер занят
 * или сеть моргнула (421 «Server busy», тайм-аут). Новый или перепроверяемый
 * вручную ящик в таком случае остаётся «на проверке» и пробует снова.
 */
const TRANSIENT_CODES: ReadonlySet<SendErrorCode> = new Set([
  'temporary',
  'rate_limit',
  'network',
  'inflight_drop',
  'auth_temporary',
]);

export function isTransientCheckFailure(code: SendErrorCode | undefined): boolean {
  return code != null && TRANSIENT_CODES.has(code);
}

/** Пауза между повторами временно не прошедшей проверки и их потолок (час). */
export const PENDING_RETRY_MS = 10 * 60_000;
export const PENDING_MAX_TRANSIENT_ATTEMPTS = 6;
