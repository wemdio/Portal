/**
 * Чистые помощники для Instantly rate-limiter'а. БЕЗ импортов/сайд-эффектов →
 * тривиально тестируются без БД.
 *
 * ВАЖНО: refill()/waitSeconds() ЗЕРКАЛЯТ SQL-функцию public.instantly_acquire_token
 * (supabase/migrations/20260607_0002_instantly_rate_budget.sql) — для быстрого
 * регресс-теста алгоритма без Postgres. В проде источник истины — SQL (атомарность
 * под конкурентностью даёт именно он); эти функции прод-кодом НЕ вызываются.
 * Держать в синхроне при изменении SQL.
 */

/** Ленивое пополнение бакета: токены + прошедшее_время × скорость, но не выше ёмкости. */
export function refill(tokens: number, maxTokens: number, refillRate: number, elapsedSec: number): number {
  return Math.min(maxTokens, tokens + Math.max(0, elapsedSec) * refillRate);
}

/** Секунд ждать до накопления p_cost токенов. 0 — хватает сейчас; Infinity — refill выключен. */
export function waitSeconds(tokens: number, cost: number, refillRate: number): number {
  if (tokens >= cost) return 0;
  if (refillRate <= 0) return Infinity;
  return (cost - tokens) / refillRate;
}

/**
 * Прод-логика: сколько мс спать перед повтором acquire, исходя из совета сервера
 * (wait в секундах) и остатка бюджета ожидания (ms). Зажато снизу floorMs (чтобы
 * не молотить БД), сверху — остатком дедлайна; ±25% jitter против thundering-herd.
 * `rand` параметризован (0..1) ради детерминированного теста.
 */
export function computeSleepMs(
  waitSec: number,
  remainingMs: number,
  rand: number = Math.random(),
  floorMs = 100,
): number {
  if (remainingMs <= 0) return 0;
  const base = Math.min(Math.max(waitSec, 0) * 1000, remainingMs);
  const jittered = base * (0.75 + rand * 0.5);
  return Math.min(remainingMs, Math.max(floorMs, jittered));
}
