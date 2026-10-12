/**
 * Manual scoring worker — обрабатывает client_manual_score_runs.
 *
 * Long-running daemon. Polls БД на pending runs, обрабатывает по одному.
 * Если воркер убит посреди прогона — следующий старт продолжит с того места,
 * где остановился (processManualRun идемпотентен — берёт только rows где
 * bucket IS NULL).
 *
 * При обычном старте вызывает cleanup_expired_manual_score_runs() — удаляет
 * прогоны старше 30 дней (см. миграцию 0013). В opt-in приоритете №24 cleanup
 * пропускается, чтобы не менять посторонние прогоны.
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { processManualRun } from '@/lib/jobs/manualScoringRunner';
import { resolveMailganerScoringConcurrency } from '@/lib/jobs/mailganerScoringThrottle';
import {
  claimRun24Priority, createRun24PriorityPool, isRun24PriorityEnabled,
  Run24PrioritySelector, type ManualPendingRun,
} from '@/lib/jobs/manualScoringRun24Priority';

const WORKER_ID = 'manual-scoring';

class PendingRunQueryError extends Error {}

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
  const priorityEnabled = isRun24PriorityEnabled(process.env.MANUAL_SCORING_RUN24_PRIORITY_ONCE);
  const prioritySelector = new Run24PrioritySelector(priorityEnabled);
  const priorityPool = priorityEnabled ? createRun24PriorityPool(process.env) : null;
  priorityPool?.on('error', () => log('error', 'Run24 priority database connection error'));

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

  // The opt-in one-shot must not delete any unrelated expired run at startup.
  if (priorityEnabled) {
    log('info', 'Run24 one-shot priority enabled; startup cleanup skipped');
  } else {
    try {
      const { data } = await supabase.rpc('cleanup_expired_manual_score_runs');
      const deleted = typeof data === 'number' ? data : 0;
      if (deleted > 0) log('info', `Cleanup: removed ${deleted} expired runs`);
    } catch (err) {
      log('warn', 'Cleanup function failed (ok on first run before migration)', err);
    }
  }

  const isShuttingDown = setupGracefulShutdown(log);

  while (!isShuttingDown()) {
    try {
      const pending = await prioritySelector.selectNext(async () => {
        // Keep the ordinary queue ordering unchanged, including its tie behaviour.
        const { data, error } = await supabase
          .from('client_manual_score_runs')
          .select('id, client_user_id, source_filename, unique_count')
          .eq('status', 'pending')
          .order('started_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (error) throw new PendingRunQueryError(error.message);
        return data as ManualPendingRun | null;
      }, () => {
        if (!priorityPool) throw new Error('Run24 priority pool is not initialized');
        return claimRun24Priority(priorityPool);
      });

      if (!pending) {
        await sleep(10_000);
        continue;
      }

      const run = pending;
      log('info', `→ Processing run ${run.id} (${run.unique_count} domains, file: ${run.source_filename ?? '?'})`);
      const startedAt = Date.now();

      const result = await processManualRun({
        runId: run.id,
        endpoint,
        concurrency: scoringConcurrency,
        onProgress: async (processed) => {
          await supabase
            .from('client_manual_score_runs')
            .update({ processed_count: processed })
            .eq('id', run.id);
        },
      });

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      log(
        'info',
        `← Run ${run.id} ${result.status} in ${elapsed}s: storage=${result.buckets.storage}, medium=${result.buckets.medium}, high=${result.buckets.high}, top=${result.buckets.top}, invalid=${result.buckets.invalid}`,
      );
    } catch (err) {
      log('error', err instanceof PendingRunQueryError ? 'Failed to query pending runs' : 'Worker loop error', err);
      await sleep(err instanceof PendingRunQueryError ? 15_000 : 30_000);
    }
  }

  log('info', 'Graceful shutdown');
  await priorityPool?.end();
  process.exit(0);
}

void main().catch((err) => {
  console.error('[worker][manual-scoring][FATAL]', err);
  process.exit(1);
});
