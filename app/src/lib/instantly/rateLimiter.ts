import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { computeSleepMs } from './rateLimiterMath';

/**
 * Распределённый rate-limiter для Instantly API поверх Postgres token-bucket'а
 * (RPC public.instantly_acquire_token, миграция 20260607_0002_instantly_rate_budget).
 *
 * Зачем: лимит Instantly общий на WORKSPACE (~10-15 RPM) поверх разных API-ключей,
 * а в один workspace стучатся несколько процессов; in-process лимитеры не видят
 * друг друга. См. wiki/log.md (инцидент 22.05.2026) и заголовок миграции.
 *
 * ГЛАВНЫЙ ПРИНЦИП — лимитер может только ЗАДЕРЖАТЬ запрос, но НИКОГДА его не
 * сломать. Любой сбой (флаг выключен, нет supabaseAdmin, RPC ещё не накатан,
 * медленная/висящая БД, мусор в ответе, исключение) → запрос проходит как сегодня.
 * Включается флагом INSTANTLY_RATE_LIMITER_ENABLED=1 (по умолчанию ВЫКЛ).
 */

const RPC_TIMEOUT_MS = 2500; // свой короткий таймаут на RPC, чтобы 120-сек таймаут
                             // supabaseAdmin не подвесил клиентский Instantly-запрос
const DEFAULT_MAX_WAIT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function maxWaitMs(): number {
  const raw = Number(process.env.INSTANTLY_RATE_LIMITER_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_WAIT_MS;
}

/**
 * Берёт один токен из общего бюджета workspace перед вызовом Instantly.
 * Блокирует (спит) пока бюджет не позволит — но не дольше INSTANTLY_RATE_LIMITER_MAX_WAIT_MS,
 * после чего fail-open пропускает запрос. Никогда не бросает.
 */
export async function acquireInstantlyToken(accountId: string): Promise<void> {
  try {
    // 1. Kill-switch — по умолчанию выключено, нулевой оверхед.
    if (process.env.INSTANTLY_RATE_LIMITER_ENABLED !== '1') return;
    // 2. Нет service-role клиента (тесты / не сконфигурён env) → fail-open.
    if (!supabaseAdmin) return;

    const deadline = Date.now() + maxWaitMs();

    for (;;) {
      let wait: number;
      try {
        const { data, error } = await supabaseAdmin
          .rpc('instantly_acquire_token', { p_account: accountId })
          .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
        if (error) {
          // RPC ещё не накатан / stale schema cache / БД-ошибка → пропускаем.
          console.warn(`[instantly-ratelimit] rpc error for "${accountId}": ${error.message || error.code || 'unknown'} — proceeding`);
          return;
        }
        wait = Number(data);
      } catch (e) {
        // Таймаут/abort/исключение → fail-open.
        console.warn(`[instantly-ratelimit] rpc threw for "${accountId}": ${(e as Error)?.message || 'unknown'} — proceeding`);
        return;
      }

      // Мусор/NaN/null или 0 → считаем «выдан», идём.
      if (!Number.isFinite(wait) || wait <= 0) return;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.warn(`[instantly-ratelimit] max wait reached for "${accountId}" — proceeding`);
        return;
      }
      await sleep(computeSleepMs(wait, remaining));
    }
  } catch (e) {
    // Абсолютный предохранитель — наружу в request() ничего не летит.
    try {
      console.warn(`[instantly-ratelimit] unexpected error — proceeding: ${(e as Error)?.message || 'unknown'}`);
    } catch {
      /* noop */
    }
  }
}
