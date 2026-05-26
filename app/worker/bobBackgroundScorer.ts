/**
 * Background BoB scorer — long-running daemon.
 *
 * Крутится 24/7 в фоне. Постоянно читает background_scorer_state из БД и
 * если enabled=true — берёт batch из BoB, скорит через Mailganer, пишет
 * в mailganer_domain_scores. Между batch'ами спит N миллисекунд (config
 * в state).
 *
 * Через 5-10 дней работы (при default pacing 50 doms × 2s sleep =
 * 25 doms/sec пиково, ~7-10 batch'ей/мин = ~25-40k доменов/час) — кэш
 * покроет весь BoB. После этого auto-pipeline cron берёт активные домены
 * прямо из mailganer_domain_scores без дёрганья Mailganer вообще.
 *
 * Resilience:
 *   - При SIGTERM — graceful shutdown (дожидается текущего tick'а)
 *   - При перезапуске — читает offset из БД и продолжает с того же места
 *   - При ошибке Mailganer/БД — single tick fail-ит, последующие
 *     продолжают работу (последний error виден в state.last_error)
 *
 * Деплой:
 *   - Отдельный docker-сервис portal-worker-bob-scorer в compose
 *   - restart: unless-stopped → автоматически поднимается после redeploy
 *   - WORKER_KIND не нужен (есть отдельный entry в Dockerfile.worker)
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { runBobScoringTick, loadScorerState } from '@/lib/jobs/bobScoringRunner';

const WORKER_ID = 'bob-bg-scorer';

/**
 * Mailganer endpoint конфиг. У фонового scorer'а нет «клиента», он работает
 * глобально — поэтому берём endpoint из env, не из БД клиентских configs.
 * Эти же значения захардкодены в Mailganer@test.ru config — кастомное
 * приложение клиента, общее для всего портала.
 */
function getEndpointConfig() {
  return {
    url: process.env.MAILGANER_ENDPOINT_URL || 'https://mailganer.com/api/v2/domain-spf-score/',
    apiKey: process.env.MAILGANER_API_KEY || '',
    authScheme: process.env.MAILGANER_AUTH_SCHEME || 'CodeRequest',
    timeoutMs: Number(process.env.MAILGANER_TIMEOUT_MS ?? '10000'),
  };
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  requireSupabaseAdmin(log);
  const endpoint = getEndpointConfig();

  if (!endpoint.apiKey) {
    log('error', 'MAILGANER_API_KEY env not set — cannot start background scorer');
    process.exit(1);
  }

  log('info', `Started. Endpoint=${endpoint.url} authScheme=${endpoint.authScheme}`);

  const isShuttingDown = setupGracefulShutdown(log);

  // Метрики сессии — сбрасываются при перезапуске контейнера, для долгосрочных
  // метрик есть state.domains_scored_total.
  let sessionTicks = 0;
  let sessionScored = 0;
  let sessionActive = 0;

  while (!isShuttingDown()) {
    try {
      const state = await loadScorerState();
      if (!state) {
        log('warn', 'state not loaded — retry in 30s');
        await sleep(30_000);
        continue;
      }

      if (!state.enabled) {
        // UI кнопкой выключили — спим 30s, потом проверяем снова.
        // Не паникуем, не логируем каждый раз (заспамит лог).
        await sleep(30_000);
        continue;
      }

      const result = await runBobScoringTick(endpoint);

      if (result.status === 'tick_done') {
        sessionTicks++;
        sessionScored += result.domainsScored;
        sessionActive += result.domainsActive;

        // Каждые 20 тиков логируем сводку (~1k доменов при batch=50)
        if (sessionTicks % 20 === 0) {
          log(
            'info',
            `Session: ticks=${sessionTicks} scored=${sessionScored} active=${sessionActive} (last batch: scanned=${result.domainsScanned} scored=${result.domainsScored} active=${result.domainsActive} cacheHits=${result.cacheHits})`,
          );
        }

        await sleep(state.sleep_between_batches_ms);
        continue;
      }

      if (result.status === 'exhausted') {
        log('info', 'Exhausted BoB data — disabling scorer + sleeping 1h before next check');
        // Опционально: автоматически выключить enabled чтобы UI показал 100%.
        // Делаем это здесь, в воркере, потому что offset уже за пределами.
        // Iter 3 UI добавит «Reset progress» кнопку чтобы пройти по второму
        // кругу если когда-нибудь понадобится.
        await sleep(3600_000);
        continue;
      }

      if (result.status === 'error') {
        log('error', `Tick error: ${result.errorMessage}`);
        // Не paniccrash'имся, спим дольше и пробуем снова
        await sleep(60_000);
        continue;
      }

      // disabled / fallback
      await sleep(30_000);
    } catch (err) {
      log('error', 'Unexpected loop error', err);
      await sleep(60_000);
    }
  }

  log('info', `Graceful shutdown — session: ticks=${sessionTicks} scored=${sessionScored} active=${sessionActive}`);
  process.exit(0);
}

void main().catch((err) => {
  console.error('[worker][bob-bg-scorer][FATAL]', err);
  process.exit(1);
});
