/**
 * Always-on воркер автопродления подписок ЮКассы.
 *
 * Каждый тик (по умолчанию 5 мин, override через AUTORENEW_TICK_MS) дёргает
 * runAutoRenewBatch() из lib/billing.ts:
 *   1. Берёт все client_tariffs с auto_renew=true, билинг=autopayment,
 *      привязанной картой (yookassa_payment_method_id != null) и paid_until
 *      в ближайшие 24ч.
 *   2. Для каждого вызывает chargeMonthlyRenewal → POST /v3/payments по
 *      сохранённой карте через нужный магазин (prod/test). Идемпотентность
 *      по (tariffId, YYYY-MM) — повторный запуск в том же месяце безопасен.
 *
 * Один и тот же воркер обслуживает прод-магазин (месячные/полугодовые/годовые
 * подписки) и тест-магазин (минутные периоды через test_period_minutes).
 *
 * Деплой: отдельный сервис portal-worker-autorenew в docker-compose.prod.yml
 * (command: node /app/workers/autoRenewCron.js), restart: unless-stopped.
 * Бандл собирается в Dockerfile.worker (esbuild).
 *
 * Resilience: SIGTERM ждёт завершения текущего тика, потом выходит. Между
 * тиками сидит в sleep — на редеплое останавливается быстро.
 */

import { createWorkerLogger, setupGracefulShutdown, sleep } from './_shared';
import { runAutoRenewBatch } from '@/lib/billing';
import { isYookassaConfigured } from '@/lib/yookassa';

const WORKER_ID = 'auto-renew-cron';
const TICK_MS = Number(process.env.AUTORENEW_TICK_MS ?? '300000'); // 5 мин

async function tickOnce(log: ReturnType<typeof createWorkerLogger>): Promise<void> {
  const startedAt = Date.now();

  if (!isYookassaConfigured()) {
    log('info', 'Tick skipped: YOOKASSA prod creds not configured');
    return;
  }

  try {
    const batch = await runAutoRenewBatch();
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    if (batch.processed === 0) {
      log('info', `No subscriptions due. elapsed=${elapsedSec}s`);
      return;
    }

    log(
      batch.failed > 0 ? 'warn' : 'info',
      `processed=${batch.processed} succeeded=${batch.succeeded} failed=${batch.failed} elapsed=${elapsedSec}s`,
    );

    for (const r of batch.results) {
      if (r.success) {
        log('info', `  ✓ ${r.user_id} → invoice ${r.invoice_id}`);
      } else {
        log('warn', `  ✗ ${r.user_id}: ${r.error ?? 'unknown'}`);
      }
    }
  } catch (err) {
    log('error', 'Tick crashed', err);
  }
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  const shouldStop = setupGracefulShutdown(log);

  log('info', `Starting auto-renew worker. TICK_MS=${TICK_MS} (${Math.round(TICK_MS / 60_000)} min)`);

  while (!shouldStop()) {
    await tickOnce(log);
    // Между тиками — лёгкий busy-wait, чтобы SIGTERM перехватывался быстро.
    const stopAt = Date.now() + TICK_MS;
    while (Date.now() < stopAt && !shouldStop()) {
      await sleep(Math.min(5_000, stopAt - Date.now()));
    }
  }

  log('info', 'Stopped.');
}

void main().catch((err) => {
  console.error('[worker][auto-renew-cron][FATAL]', err);
  process.exit(1);
});
