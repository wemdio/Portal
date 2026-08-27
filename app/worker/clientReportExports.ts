/**
 * Dedicated large client-report exporter.
 *
 * It intentionally runs outside the interactive/ingest workers: PostgreSQL
 * streams COPY output directly through gzip to private S3, one job at a time.
 */

import {
  closeClientReportExportPool,
  processNextClientReportExport,
  recoverRunningClientReportExports,
} from '@/lib/clientReports/exportWorker';

const POLL_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.CLIENT_REPORT_EXPORT_POLL_MS ?? process.env.WORKER_POLL_INTERVAL_MS ?? '5000'),
);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.info(`[client-report-export] ${signal}: stopping after the current export`);
    stopping = true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Startup DB wait.
 *
 * After a host reboot or a cgroup OOM, Postgres spends a minute or two in crash
 * recovery and answers every client with `57P03: the database system is in
 * recovery mode`. recoverRunningClientReportExports() runs before the main loop
 * and outside its try/catch, so that error killed the process with exit 1 —
 * docker restarted it, it died again, and after five deaths loop-watchdog set
 * restart=no. On 13-14.08.2026 the container was left down until someone
 * started it by hand three separate times.
 *
 * Retrying the recovery call is safe: it only requeues jobs left in `running`,
 * which is idempotent.
 */
const DB_WAIT_TIMEOUT_MS = Math.max(0, Number(process.env.DB_WAIT_TIMEOUT_MS ?? '300000'));

async function recoverWithRetry(): Promise<number> {
  const deadline = Date.now() + DB_WAIT_TIMEOUT_MS;
  let delay = 1_000;
  for (let attempt = 1; ; attempt += 1) {
    if (stopping) return 0;
    try {
      return await recoverRunningClientReportExports();
    } catch (error) {
      // Past the deadline the error is real (bad credentials, broken schema) —
      // let it through so the container fails loudly instead of looping quietly.
      if (Date.now() >= deadline) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[client-report-export] DB unavailable (attempt ${attempt}): ${message}. ` +
          `Retrying in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

async function main(): Promise<void> {
  console.info(`[client-report-export] started (pid=${process.pid})`);
  try {
    const recovered = await recoverWithRetry();
    if (recovered > 0) console.info(`[client-report-export] requeued ${recovered} interrupted job(s)`);
    while (!stopping) {
      try {
        const processed = await processNextClientReportExport();
        if (!processed && !stopping) await sleep(POLL_INTERVAL_MS);
      } catch (error) {
        console.error('[client-report-export] job failed:', error);
        if (!stopping) await sleep(POLL_INTERVAL_MS);
      }
    }
  } finally {
    await closeClientReportExportPool();
  }
  console.info('[client-report-export] stopped');
}

main().catch((error) => {
  console.error('[client-report-export] worker crashed:', error);
  process.exitCode = 1;
});
