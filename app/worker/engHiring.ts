import { runEngHiringParserJob } from '@/lib/parsers/engHiringRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { claimParserJob, recoverRunningParserJobs } from './parserJobs';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const WORKER_ID = `eng-hiring-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
let engHiringJobActive = false;

async function startupRecovery(): Promise<void> {
  await recoverRunningParserJobs(log, ['eng_hiring'], 'ENG hiring parser_jobs');
}

async function claimEngHiringJob(): Promise<string | null> {
  if (engHiringJobActive) return null;
  return claimParserJob(log, 'eng_hiring');
}

async function pollOnce(): Promise<boolean> {
  const jobId = await claimEngHiringJob();
  if (jobId) {
    engHiringJobActive = true;
    const task = (async () => {
      log('info', `Running ENG hiring parser job ${jobId}`);
      try {
        await runEngHiringParserJob(jobId);
      } catch (err) {
        log('error', `ENG hiring parser job ${jobId} crashed`, err);
      }
    })();
    running.add(task);
    void task.finally(() => {
      running.delete(task);
      engHiringJobActive = false;
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
  log('info', `Starting ENG hiring worker (pid=${process.pid})`);
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
