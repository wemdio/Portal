import { runHHParserJob } from '@/lib/parsers/hhRunner';
import { runHHArchiveJob } from '@/lib/parsers/hhArchive/runner';
import { runYandexDirectJob } from '@/lib/parsers/yandexDirect/runner';
import { runAtsParserJob } from '@/lib/parsers/atsRunner';
import { runAdzunaParserJob } from '@/lib/parsers/adzunaRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 3;
const DRAIN_TIMEOUT_MS = Number(process.env.WORKER_DRAIN_TIMEOUT_MINUTES ?? '180') * 60 * 1000;
const WORKER_ID = `hh-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
// Архивные job'ы обрабатываются строго по одному за раз: rate-limit HH общий
// на IP, параллельные запросы к api.hh.ru от нескольких потоков → быстрый
// бан. Обычные HTML-парс задачи (parser_jobs) могут бежать MAX_CONCURRENCY=3
// параллельно, потому что hh.ru/search/vacancy менее agressive на rate.
let archiveJobActive = false;
// Yandex Direct job'ы — тоже глобально один за раз: XMLStock rate-limit на
// аккаунт. Источник данных (xmlstock.com) не пересекается с hh.ru, поэтому
// может бежать параллельно обычным HH-парс задачам.
let yandexDirectJobActive = false;
// ATS-парсер (Greenhouse/Lever/Ashby) — глобально один за раз: ходит по тысячам
// внешних бордов + Clearbit, держим concurrency=1, чтобы не словить rate-limit.
let atsJobActive = false;
// Adzuna («весь рынок») — глобально один за раз: curl к Adzuna API + Clearbit.
let adzunaJobActive = false;

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data: hhJobs, error: hhErr } = await db
    .from('parser_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (hhErr) log('warn', 'Startup recovery: parser_jobs update failed', hhErr);
  else if (hhJobs?.length) log('info', `Startup recovery: reset ${hhJobs.length} parser_jobs to pending`);

  // Yandex Direct processing-задачи без heartbeat — сбрасываем в pending.
  const ydCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: ydJobs, error: ydErr } = await db
    .from('yandex_direct_jobs')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .lt('updated_at', ydCutoff)
    .select('id');
  if (ydErr) log('warn', 'Startup recovery: yandex_direct_jobs update failed', ydErr);
  else if (ydJobs?.length) log('info', `Startup recovery: reset ${ydJobs.length} yandex_direct_jobs to pending`);

  // Архивные processing-задачи без heartbeat — сбрасываем в pending для повторного клейма.
  // Heartbeat-cutoff 30 мин: реальная работа на чанке = 1-2 минуты, 30 мин без
  // прогресса = воркер умер.
  const cutoffIso = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: archiveJobs, error: archiveErr } = await db
    .from('hh_archive_jobs')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .lt('updated_at', cutoffIso)
    .select('id');
  if (archiveErr) log('warn', 'Startup recovery: hh_archive_jobs update failed', archiveErr);
  else if (archiveJobs?.length) log('info', `Startup recovery: reset ${archiveJobs.length} hh_archive_jobs to pending`);
}

async function claimHHJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .eq('parser_type', 'hh_vacancies')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

/**
 * Атомарно клеймит один pending hh_archive_jobs. Глобальная concurrency=1
 * (HH rate-limit shared по IP), поэтому проверяем archiveJobActive флаг.
 */
async function claimHHArchiveJob(): Promise<string | null> {
  if (archiveJobActive) return null;
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('hh_archive_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('hh_archive_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

/** Атомарно клеймит один pending yandex_direct_jobs (concurrency=1). */
async function claimYandexDirectJob(): Promise<string | null> {
  if (yandexDirectJobActive) return null;
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('yandex_direct_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('yandex_direct_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

/**
 * Атомарно клеймит один pending ATS parser_jobs (parser_type='ats_companies').
 * Глобальная concurrency=1 (atsJobActive): много внешних запросов + Clearbit.
 */
async function claimAtsJob(): Promise<string | null> {
  if (atsJobActive) return null;
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .eq('parser_type', 'ats_companies')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

/**
 * Атомарно клеймит один pending Adzuna parser_jobs (parser_type='adzuna_companies').
 * Глобальная concurrency=1 (adzunaJobActive): много curl-запросов к Adzuna + Clearbit.
 */
async function claimAdzunaJob(): Promise<string | null> {
  if (adzunaJobActive) return null;
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .eq('parser_type', 'adzuna_companies')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

async function pollOnce(): Promise<boolean> {
  // Сначала пробуем обычный HH-парсер (concurrency=3, обычно есть свободный слот).
  if (running.size < MAX_CONCURRENCY) {
    const jobId = await claimHHJob();
    if (jobId) {
      const task = (async () => {
        log('info', `Running HH parser job ${jobId}`);
        await runHHParserJob(jobId, DRAIN_TIMEOUT_MS);
      })();
      running.add(task);
      void task.finally(() => running.delete(task));
      return true;
    }
  }

  // ATS-парсер (Greenhouse/Lever/Ashby) — глобально один на воркер.
  if (!atsJobActive) {
    const atsJobId = await claimAtsJob();
    if (atsJobId) {
      atsJobActive = true;
      const task = (async () => {
        log('info', `Running ATS parser job ${atsJobId}`);
        try {
          await runAtsParserJob(atsJobId);
        } catch (err) {
          log('error', `ATS parser job ${atsJobId} crashed`, err);
        }
      })();
      running.add(task);
      void task.finally(() => {
        running.delete(task);
        atsJobActive = false;
      });
      return true;
    }
  }

  // Adzuna («весь рынок») — глобально один на воркер.
  if (!adzunaJobActive) {
    const adzunaJobId = await claimAdzunaJob();
    if (adzunaJobId) {
      adzunaJobActive = true;
      const task = (async () => {
        log('info', `Running Adzuna parser job ${adzunaJobId}`);
        try {
          await runAdzunaParserJob(adzunaJobId);
        } catch (err) {
          log('error', `Adzuna parser job ${adzunaJobId} crashed`, err);
        }
      })();
      running.add(task);
      void task.finally(() => {
        running.delete(task);
        adzunaJobActive = false;
      });
      return true;
    }
  }

  // Архив — глобально один на воркер.
  if (!archiveJobActive) {
    const archiveJobId = await claimHHArchiveJob();
    if (archiveJobId) {
      archiveJobActive = true;
      const task = (async () => {
        log('info', `Running HH archive job ${archiveJobId}`);
        try {
          const db = requireSupabaseAdmin(log);
          await runHHArchiveJob(db, archiveJobId);
        } catch (err) {
          log('error', `HH archive job ${archiveJobId} crashed`, err);
        }
      })();
      running.add(task);
      void task.finally(() => {
        running.delete(task);
        archiveJobActive = false;
      });
      return true;
    }
  }

  // Yandex Direct — глобально один на воркер (XMLStock rate-limit).
  if (!yandexDirectJobActive) {
    const ydJobId = await claimYandexDirectJob();
    if (ydJobId) {
      yandexDirectJobActive = true;
      const task = (async () => {
        log('info', `Running Yandex Direct job ${ydJobId}`);
        try {
          const db = requireSupabaseAdmin(log);
          await runYandexDirectJob(db, ydJobId);
        } catch (err) {
          log('error', `Yandex Direct job ${ydJobId} crashed`, err);
        }
      })();
      running.add(task);
      void task.finally(() => {
        running.delete(task);
        yandexDirectJobActive = false;
      });
      return true;
    }
  }

  if (running.size >= MAX_CONCURRENCY) {
    await sleep(250);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  log('info', `Starting HH worker (pid=${process.pid})`);
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
    realtimeTables: ['parser_jobs', 'hh_archive_jobs', 'yandex_direct_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

