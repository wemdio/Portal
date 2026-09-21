import { runPolzaOutreachJob } from '@/lib/polzaOutreach/runner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { claimParserJob, recoverRunningParserJobs } from './parserJobs';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const WORKER_ID = `polza-outreach-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
let polzaOutreachJobActive = false;

async function startupRecovery(): Promise<void> {
  await recoverRunningParserJobs(log, ['polza_outreach'], 'Polza outreach parser_jobs');
}

async function claimPolzaOutreachJob(): Promise<string | null> {
  if (polzaOutreachJobActive) return null;
  return claimParserJob(log, 'polza_outreach');
}

async function pollOnce(): Promise<boolean> {
  const jobId = await claimPolzaOutreachJob();
  if (jobId) {
    polzaOutreachJobActive = true;
    const task = (async () => {
      log('info', `Running Polza outreach parser job ${jobId}`);
      try {
        await runPolzaOutreachJob(jobId);
      } catch (err) {
        log('error', `Polza outreach parser job ${jobId} crashed`, err);
      }
    })();
    running.add(task);
    void task.finally(() => {
      running.delete(task);
      polzaOutreachJobActive = false;
    });
    return true;
  }

  if (running.size > 0) {
    await sleep(250);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  log('info', `Starting Polza outreach worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['parser_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
