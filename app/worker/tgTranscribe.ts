import {
  extractVideoInfo,
  processVideoMessage,
  saveErrorRecord,
  type TgMessage,
  type VideoInfo,
} from '@/lib/tgTranscribe';
import { runTgScanJob } from '@/lib/tgScanWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = Number(process.env.TG_TRANSCRIBE_WORKER_MAX_CONCURRENCY ?? '2');
const WORKER_ID = `tg-transcribe-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

type TgTranscribeJobRow = {
  id: string;
  tg_chat_id: number;
  tg_message_id: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  payload: {
    msg?: TgMessage;
    videoInfo?: VideoInfo;
  } | null;
};

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);

  const { data: transcribeJobs, error: transcribeError } = await db
    .from('tg_transcribe_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .select('id');
  if (transcribeError) log('warn', 'Startup recovery: tg_transcribe_jobs update failed', transcribeError);
  else if (transcribeJobs?.length) log('info', `Startup recovery: reset ${transcribeJobs.length} tg_transcribe_jobs to pending`);

  const { data: scanJobs, error: scanError } = await db
    .from('tg_scan_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .select('id');
  if (scanError) log('warn', 'Startup recovery: tg_scan_jobs update failed', scanError);
  else if (scanJobs?.length) log('info', `Startup recovery: reset ${scanJobs.length} tg_scan_jobs to pending`);
}

async function claimTranscribeJob(): Promise<TgTranscribeJobRow | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('tg_transcribe_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_transcribe_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, tg_chat_id, tg_message_id, status, payload')
    .maybeSingle();
  return (claimed as TgTranscribeJobRow | null) ?? null;
}

async function claimScanJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('tg_scan_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_scan_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

async function runTranscribeJob(job: TgTranscribeJobRow): Promise<void> {
  const db = requireSupabaseAdmin(log);

  const msg = job.payload?.msg;
  const videoInfoFromPayload = job.payload?.videoInfo;
  const resolvedVideoInfo = videoInfoFromPayload ?? (msg ? extractVideoInfo(msg) : null);

  if (!msg || !resolvedVideoInfo) {
    await db
      .from('tg_transcribe_jobs')
      .update({
        status: 'failed',
        error_message: 'Некорректный payload задачи',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    return;
  }

  try {
    const result = await processVideoMessage(msg, resolvedVideoInfo);

    if (result.status === 'completed' || result.status === 'skipped_exists') {
      await db
        .from('tg_transcribe_jobs')
        .update({
          status: 'completed',
          error_message: null,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
      return;
    }

    await db
      .from('tg_transcribe_jobs')
      .update({
        status: 'failed',
        error_message: result.error ?? 'Ошибка обработки',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  } catch (err) {
    await saveErrorRecord(msg, resolvedVideoInfo, err);
    const errorMessage = err instanceof Error ? err.message : 'Неизвестная ошибка';
    await db
      .from('tg_transcribe_jobs')
      .update({
        status: 'failed',
        error_message: errorMessage,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  }
}

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true;
  }

  const transcribeJob = await claimTranscribeJob();
  if (transcribeJob) {
    const task = (async () => {
      log('info', `Running TG transcribe job ${transcribeJob.id}`);
      await runTranscribeJob(transcribeJob);
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return true;
  }

  const scanJobId = await claimScanJob();
  if (scanJobId) {
    const task = (async () => {
      log('info', `Running TG scan job ${scanJobId}`);
      await runTgScanJob(scanJobId);
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return true;
  }

  return false;
}

async function main(): Promise<void> {
  log('info', `Starting TG transcribe worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  const shouldStop = setupGracefulShutdown(log);
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['tg_transcribe_jobs', 'tg_scan_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
