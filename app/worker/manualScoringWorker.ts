/**
 * Manual scoring worker — обрабатывает client_manual_score_runs.
 *
 * Long-running daemon. Polls БД на pending runs, обрабатывает по одному.
 * Если воркер убит посреди прогона — следующий старт продолжит с того места,
 * где остановился (processManualRun идемпотентен — берёт только rows где
 * bucket IS NULL).
 *
 * При старте также вызывает cleanup_expired_manual_score_runs() — удаляет
 * прогоны старше 30 дней (см. миграцию 0013).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { processManualRun } from '@/lib/jobs/manualScoringRunner';
import { resolveMailganerScoringConcurrency } from '@/lib/jobs/mailganerScoringThrottle';

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
      const { data: pending, error } = await supabase
        .from('client_manual_score_runs')
        .select('id, client_user_id, source_filename, unique_count')
        .eq('status', 'pending')
        .order('started_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        log('error', 'Failed to query pending runs', error);
        await sleep(15_000);
        continue;
      }

      if (!pending) {
        await sleep(10_000);
        continue;
      }

      const run = pending as { id: string; client_user_id: string; source_filename: string | null; unique_count: number };
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
      log('error', 'Worker loop error', err);
      await sleep(30_000);
    }
  }

  log('info', 'Graceful shutdown');
  process.exit(0);
}

void main().catch((err) => {
  console.error('[worker][manual-scoring][FATAL]', err);
  process.exit(1);
});
