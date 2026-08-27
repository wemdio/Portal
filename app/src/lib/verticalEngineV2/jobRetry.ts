/**
 * Политика автоповтора research-стадий «Движка вертикалей» (ve_jobs).
 *
 * Упавшая стадия НЕ должна требовать кнопки «Повторить» (иначе пользователь
 * перезапускает весь research с site_profile и платит за уже пройденные
 * стадии). Воркер сам переставляет failed-джобу в pending; здесь решается,
 * сколько раз и с какой задержкой (run_after) это делать.
 *
 * Транзиентные ошибки (5xx/429 от Requesty, сеть, таймауты) пережидаем с
 * экспоненциальным бэкоффом — провайдер может быть недоступен десятки секунд.
 * Постоянные ошибки (валидация схемы, нет данных, 4xx) ретраить бессмысленно —
 * они умирают быстро, как раньше.
 */

/** Попытки для постоянных ошибок — как было до автоповтора. */
export const PERMANENT_MAX_ATTEMPTS = 3;
/** Транзиентные ошибки пережидаем дольше: больше попыток + бэкофф. */
export const RETRYABLE_MAX_ATTEMPTS = 5;

const RETRY_BACKOFF_BASE_MS = 30_000;
const RETRY_BACKOFF_MAX_MS = 120_000;

/** Транзиентная ли ошибка стадии (стоит ли ждать и повторять). */
export function isRetryableStageError(msg: string): boolean {
  return (
    /\b(5\d\d|429)\b/.test(msg) ||
    /provider is currently unavailable/i.test(msg) ||
    /econnreset|econnrefused|etimedout|enotfound|network|fetch failed|socket hang up|timeout|aborted/i.test(msg)
  );
}

/** Лимит попыток для конкретной ошибки стадии. */
export function maxAttemptsFor(msg: string): number {
  return isRetryableStageError(msg) ? RETRYABLE_MAX_ATTEMPTS : PERMANENT_MAX_ATTEMPTS;
}

/**
 * `run_after` для отложенного requeue. `attempts` — номер только что
 * случившегося фейла (1-based). Для транзиентных ошибок возвращает будущее
 * время с бэкоффом (30с → 60с → 120с → 120с), для постоянных — `now` (клейм
 * сразу, как раньше).
 */
export function retryRunAfter(attempts: number, retryable: boolean, nowMs = Date.now()): string {
  if (!retryable) return new Date(nowMs).toISOString();
  const delay = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1), RETRY_BACKOFF_MAX_MS);
  return new Date(nowMs + delay).toISOString();
}
