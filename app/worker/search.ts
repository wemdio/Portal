import { runSearchParserJob } from '@/lib/parsers/searchParserWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 5;
const WORKER_ID = `search-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(350);
    return true;
  }
  let claimed = false;
  const task = (async () => { claimed = await runSearchParserJob(); })();
  running.add(task);
  void task.finally(() => running.delete(task)).catch((error) => log('warn', 'Search execution failed', error));
  // Claim/start asynchronously; the DB, rather than this process, owns slots.
  await Promise.race([task, sleep(100)]);
  return running.size > 0 || claimed;
}

async function main(): Promise<void> {
  log('info', `Starting Search worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  // Stale leases are recovered by the claim RPC; healthy jobs are untouched.

  await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ['search_parser_jobs'] });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

