import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { computeSleepMs } from '@/lib/instantly/rateLimiterMath';

/**
 * Жёсткий распределённый лимит запросов к Mailganer scoring-эндпоинту поверх
 * Postgres token-bucket (RPC public.mailganer_acquire_score_token, миграция
 * 20260617_0002_mailganer_scoring_rate_budget).
 *
 * Зачем: клиент Mailganer просит ≤20k запросов/сутки и равномерно (их эндпоинт
 * делает DNS-парсинг, не рассчитан на поток). Лимит общий ПОВЕРХ всех воркеров
 * (bob-scorer фоновый + большой файл, добор, ручной скоринг); in-process
 * concurrency этого не решает — потолок глобальный.
 *
 * Семантика — ОТЛИЧАЕТСЯ от instantly-лимитера (тот всегда fail-open пропускает):
 *  - бюджет исчерпан → ждём накопления токена, но не дольше max-wait. В штатном
 *    режиме следующий токен ≤ нескольких секунд (rate ~14/мин), так воркер
 *    просто РОВНО пейсится и большой файл сливается полностью, но медленно.
 *  - если за max-wait токена так и нет (патологическая конкуренция) → false:
 *    вызывающий ПРОПУСКАЕТ домен (возьмёт в следующий тик). Так держим ЖЁСТКИЙ
 *    суточный потолок и НИКОГДА не шлём сверх лимита.
 *  - инфраструктурный сбой лимитера (нет supabaseAdmin / RPC не накатан /
 *    таймаут / мусор) → fail-OPEN (true): баг лимитера не должен молча
 *    остановить весь скоринг. Такие случаи логируем.
 *
 * Выключить целиком: MAILGANER_SCORING_RATE_LIMIT_DISABLED=1.
 */

const RPC_TIMEOUT_MS = 2500; // короткий таймаут на RPC, чтобы 120-сек дефолт supabaseAdmin не подвесил
const DEFAULT_MAX_WAIT_MS = 120_000; // фоновому скореру не жалко подождать — это и есть пейсинг

/**
 * Пауза, прерываемая сигналом.
 *
 * Ожидание токена — самая длинная пауза на пути к Mailganer (до max-wait, по
 * умолчанию 120 с). Пока она не была прерываемой, воркер на едином жизненном
 * цикле (ручной скоринг) после SIGTERM продолжал спать здесь и не успевал
 * отдать аренду в отведённый бюджет остановки. Сигнал необязателен: остальные
 * вызывающие (фоновый скорер, добор) зовут без него и спят как прежде.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted) {
      r();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      r();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function maxWaitMs(): number {
  const raw = Number(process.env.MAILGANER_SCORING_RATE_LIMIT_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_WAIT_MS;
}

/**
 * Берёт один токен из суточного бюджета Mailganer-скоринга перед запросом.
 *   true  — слать запрос можно (токен выдан, либо лимитер недоступен → fail-open).
 *   false — бюджет исчерпан и за max-wait не освободился → ПРОПУСТИТЬ домен.
 * Никогда не бросает.
 *
 * `signal` (необязателен) прерывает ожидание токена: вызывающий на едином
 * жизненном цикле задач обязан бросить платную работу, как только аренда
 * потеряна или пришёл SIGTERM. Прерванное ожидание отвечает false — «домен
 * пропустить», ровно как исчерпанный бюджет; повторная попытка достанется
 * следующему владельцу прогона.
 */
export async function acquireMailganerScoreToken(signal?: AbortSignal): Promise<boolean> {
  try {
    // Kill-switch — мгновенный обход.
    if (process.env.MAILGANER_SCORING_RATE_LIMIT_DISABLED === '1') return true;
    if (signal?.aborted) return false;
    // Нет service-role клиента (тесты / не сконфигурён env) → fail-open.
    if (!supabaseAdmin) return true;

    const deadline = Date.now() + maxWaitMs();

    for (;;) {
      if (signal?.aborted) return false;
      let wait: number;
      try {
        const { data, error } = await supabaseAdmin
          .rpc('mailganer_acquire_score_token', {})
          .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
        if (error) {
          // RPC ещё не накатан / stale schema cache / БД-ошибка → fail-open.
          console.warn(`[mailganer-ratelimit] rpc error: ${error.message || error.code || 'unknown'} — proceeding (fail-open)`);
          return true;
        }
        wait = Number(data);
      } catch (e) {
        // Таймаут/abort/исключение → fail-open.
        console.warn(`[mailganer-ratelimit] rpc threw: ${(e as Error)?.message || 'unknown'} — proceeding (fail-open)`);
        return true;
      }

      // Мусор/NaN/null или 0 → токен выдан, идём.
      if (!Number.isFinite(wait) || wait <= 0) return true;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Бюджет исчерпан и не освободился за max-wait → ЖЁСТКО пропускаем домен.
        return false;
      }
      await sleep(computeSleepMs(wait, remaining), signal);
    }
  } catch (e) {
    // Абсолютный предохранитель — наружу ничего не летит, скоринг не ломаем.
    try {
      console.warn(`[mailganer-ratelimit] unexpected error — proceeding: ${(e as Error)?.message || 'unknown'}`);
    } catch {
      /* noop */
    }
    return true;
  }
}
