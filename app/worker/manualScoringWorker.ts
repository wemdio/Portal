/**
 * Manual scoring worker — обрабатывает client_manual_score_runs.
 *
 * Long-running daemon. Polls БД на pending runs, обрабатывает по одному.
 * Claims are atomic and fenced. SIGTERM drains started rows and releases only
 * its own scoring lease; expired NEW scoring leases can be reclaimed. Legacy
 * processing/failed runs and ambiguous routing are never blindly requeued.
 *
 * При старте также вызывает cleanup_expired_manual_score_runs() — удаляет
 * прогоны старше 30 дней (см. миграцию 0013).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { resolveMailganerScoringConcurrency } from '@/lib/jobs/mailganerScoringThrottle';
import { claimManualScoreRun, processClaimedManualRun } from '@/lib/jobs/manualScoringLease';

const WORKER_ID = 'manual-scoring';

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
  const supabase = requireSupabaseAdmin(log);
  const endpoint = getEndpointConfig();

  if (!endpoint.apiKey) {
    log('error', 'MAILGANER_API_KEY env not set');
    process.exit(1);
  }

  log('info', `Started. Endpoint=${endpoint.url}`);
  const scoringConcurrency = resolveMailganerScoringConcurrency({
    endpointUrl: endpoint.url,
    defaultConcurrency: 5,
  });
  log('info', `Scoring concurrency=${scoringConcurrency}`);

  // Cleanup истёкших прогонов при старте
  try {
    const { data } = await supabase.rpc('cleanup_expired_manual_score_runs');
    const deleted = typeof data === 'number' ? data : 0;
    if (deleted > 0) log('info', `Cleanup: removed ${deleted} expired runs`);
  } catch (err) {
    log('warn', 'Cleanup function failed (ok on first run before migration)', err);
  }

  const isShuttingDown = setupGracefulShutdown(log);

  while (!isShuttingDown()) {
    try {
      // Missing migration/ambiguous claim fails closed: never fall back to an
      // unfenced SELECT+UPDATE, and never claim another run after uncertainty.
      const run = await claimManualScoreRun(supabase);
      if (!run) {
        await sleep(10_000);
        continue;
      }
      log('info', `→ Processing run ${run.id} (${run.unique_count} domains, file: ${run.source_filename ?? '?'})`);
      const startedAt = Date.now();

      const result = await processClaimedManualRun(supabase, run, {
        endpoint,
        concurrency: scoringConcurrency,
        shouldStop: isShuttingDown,
        onLeaseError: (error) => log('error', `Lease renewal failed for run ${run.id}`, error),
      });

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      log(
        'info',
        `← Run ${run.id} ${result.status} in ${elapsed}s: storage=${result.buckets.storage}, medium=${result.buckets.medium}, high=${result.buckets.high}, top=${result.buckets.top}, invalid=${result.buckets.invalid}`,
      );
    } catch (err) {
      // Do not overlap an unknown claim, unresolved save or routing outcome
      // with the next run. A fresh process may reclaim only a scoring lease.
      log('error', 'Worker stopped without a safe checkpoint', err);
      throw err;
    }
  }

  log('info', 'Graceful shutdown');
  process.exit(0);
}

void main().catch((err) => {
  console.error('[worker][manual-scoring][FATAL]', err);
  process.exit(1);
});
