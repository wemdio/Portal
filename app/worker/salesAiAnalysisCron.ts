/**
 * One-shot cron entry для Sales AI Analysis: набивает джобы в очередь.
 *
 * Запускается system-crontab'ом раз в сутки (03:00 MSK = 00:00 UTC), после
 * ночного синка external-sync (там 02:00 MSK). Не висит в памяти — грузит
 * список сделок-кандидатов через dealFilter.pickDealsForAnalysis, дедупит
 * по уже существующим open джобам (чтобы деплой не создавал дубли), инсертит
 * pending-джобы, выходит. Далее сам worker/salesAiAnalysis.ts (long-running)
 * их разгребает.
 *
 * Деплой:
 *   1. Добавить worker/salesAiAnalysisCron.ts в build:workers (уже сделано).
 *   2. На сервере в crontab (под пользователем приложения, не root):
 *        0 0 * * * cd /path/to/portal/app && /usr/bin/node --env-file=../.env dist/workers/salesAiAnalysisCron.js >> /var/log/portal/sales-ai-cron.log 2>&1
 *   3. Проверить: `docker exec portal-worker-sales-ai-analysis node dist/workers/salesAiAnalysisCron.js`
 */

import { createWorkerLogger, requireSupabaseAdmin } from './_shared';
import { pickDealsForAnalysis } from '@/lib/salesAiAnalysis/dealFilter';
import { syncRegulation } from '@/lib/salesAiAnalysis/regulation';

const WORKER_ID = 'sales-ai-analysis-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const db = requireSupabaseAdmin(log);

  log('info', 'Syncing regulation from embedded content…');
  const regulation = await syncRegulation(db);
  log('info', `Regulation v${regulation.version} active`);

  log('info', 'Picking deals for analysis…');
  const candidates = await pickDealsForAnalysis(db);
  log('info', `Candidates: ${candidates.length}`);
  if (candidates.length === 0) return 0;

  // Дедуп: не создаём job, если для этой сделки уже есть pending/running.
  const leadIds = candidates.map((c) => c.amo_lead_id);
  const { data: openJobs, error: openErr } = await db
    .from('sales_ai_analysis_jobs')
    .select('amo_lead_id')
    .in('amo_lead_id', leadIds)
    .in('status', ['pending', 'running']);
  if (openErr) {
    log('error', `Failed to check open jobs: ${openErr.message}`);
    return 1;
  }
  const busy = new Set(
    (openJobs ?? []).map((j) => (j as { amo_lead_id: number }).amo_lead_id),
  );

  const toEnqueue = candidates.filter((c) => !busy.has(c.amo_lead_id));
  if (toEnqueue.length === 0) {
    log('info', 'All candidates already have open jobs — nothing to enqueue');
    return 0;
  }

  const rows = toEnqueue.map((c) => ({
    amo_lead_id: c.amo_lead_id,
    trigger: 'cron',
    status: 'pending',
  }));
  const { error: insErr } = await db.from('sales_ai_analysis_jobs').insert(rows);
  if (insErr) {
    log('error', `Enqueue failed: ${insErr.message}`);
    return 1;
  }
  log('info', `Enqueued ${rows.length} jobs`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[sales-ai-analysis-cron] FATAL', err);
    process.exit(1);
  });
