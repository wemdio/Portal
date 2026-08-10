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

async function main(): Promise<void> {
  console.info(`[client-report-export] started (pid=${process.pid})`);
  try {
    const recovered = await recoverRunningClientReportExports();
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
