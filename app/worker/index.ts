/**
 * Portal background worker.
 *
 * Запускается как отдельный Docker-контейнер (Dockerfile.worker).
 * Поллит Supabase на наличие задач в статусе 'pending' и выполняет их.
 * Не зависит от Next.js — деплой портала не прерывает запущенные задачи.
 *
 * Сборка: esbuild с --conditions=react-server (нейтрализует server-only).
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runHHParserJob } from '@/lib/parsers/hhRunner';
import { runSearchParserJob } from '@/lib/parsers/searchParserWorker';
import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';
import { runYandexMapsCollectLinks, runYandexMapsParseOrganizations } from '@/lib/parsers/yandexMapsWorker';
import { runEmailValidationJob } from '@/lib/emailValidation/emailValidationWorker';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '3000');
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

let shuttingDown = false;

// --------------------------------------------------------------------------
// Logging helpers (stdout + Supabase application_logs via loggerServer)
// --------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[worker][${WORKER_ID}][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) {
    console[level](line, extra);
  } else {
    console[level](line);
  }
}

// --------------------------------------------------------------------------
// Startup recovery
// --------------------------------------------------------------------------

async function startupRecovery(): Promise<void> {
  if (!supabaseAdmin) {
    log('error', 'supabaseAdmin not configured — skipping startup recovery');
    return;
  }
  const db = supabaseAdmin;
  const now = new Date().toISOString();
  const errorMsg = 'Прервано перезапуском worker-сервиса';

  // HH vacancies parser
  const { data: hhJobs, error: hhErr } = await db
    .from('parser_jobs')
    .update({ status: 'failed', completed_at: now, error_message: errorMsg, progress_stage: 'failed' })
    .eq('status', 'running')
    .select('id');
  if (hhErr) log('warn', 'Startup recovery: parser_jobs update failed', hhErr);
  else if (hhJobs?.length) log('info', `Startup recovery: marked ${hhJobs.length} parser_jobs as failed`);

  // Search parser
  const searchUpdate = await db
    .from('search_parser_jobs')
    .update({ status: 'failed', completed_at: now, error_message: errorMsg, progress_stage: 'failed' })
    .eq('status', 'running')
    .select('id');
  const searchErr = searchUpdate.error as { code?: string; message?: string } | null;
  if (searchErr?.code === 'PGRST204' && (searchErr.message ?? '').includes("progress_stage")) {
    const fallbackUpdate = await db
      .from('search_parser_jobs')
      .update({ status: 'failed', completed_at: now, error_message: errorMsg })
      .eq('status', 'running')
      .select('id');
    if (fallbackUpdate.error) log('warn', 'Startup recovery: search_parser_jobs update failed', fallbackUpdate.error);
    else if (fallbackUpdate.data?.length) log('info', `Startup recovery: marked ${fallbackUpdate.data.length} search_parser_jobs as failed`);
  } else if (searchUpdate.error) {
    log('warn', 'Startup recovery: search_parser_jobs update failed', searchUpdate.error);
  } else if (searchUpdate.data?.length) {
    log('info', `Startup recovery: marked ${searchUpdate.data.length} search_parser_jobs as failed`);
  }

  // Website enrichment — сбрасываем в 'pending' (воркер сам продолжит с места остановки)
  const { data: enrichJobs, error: enrichErr } = await db
    .from('website_enrichment_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (enrichErr) log('warn', 'Startup recovery: website_enrichment_jobs update failed', enrichErr);
  else if (enrichJobs?.length) log('info', `Startup recovery: reset ${enrichJobs.length} website_enrichment_jobs to pending`);

  // YandexMaps — сбрасываем в 'failed' (нельзя безопасно продолжить посередине HTTP-цикла к Python-сервису)
  const { data: ymJobs, error: ymErr } = await db
    .from('yandex_maps_jobs')
    .update({ status: 'failed', error_message: 'Прервано перезапуском worker-сервиса' })
    .eq('status', 'running')
    .select('id');
  if (ymErr) log('warn', 'Startup recovery: yandex_maps_jobs update failed', ymErr);
  else if (ymJobs?.length) log('info', `Startup recovery: marked ${ymJobs.length} yandex_maps_jobs as failed`);

  // Email validation — сбрасываем в 'pending' (воркер сам продолжит с места остановки)
  const { data: evJobs, error: evErr } = await db
    .from('email_validation_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (evErr) log('warn', 'Startup recovery: email_validation_jobs update failed', evErr);
  else if (evJobs?.length) log('info', `Startup recovery: reset ${evJobs.length} email_validation_jobs to pending`);
}

// --------------------------------------------------------------------------
// Job claim helpers
// --------------------------------------------------------------------------

async function claimHHJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  // Optimistic lock: only claim if still pending
  const { data: claimed } = await db
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function claimSearchJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('search_parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('search_parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function claimEnrichJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('website_enrichment_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  // Enrichment runner handles its own 'pending' → 'running' transition
  return pending.id;
}

async function claimYandexMapsJob(): Promise<{ id: string; stage: 'collect' | 'parse' } | null> {
  const db = supabaseAdmin!;

  // Collect-links step: jobs in 'pending' status with initial stage ('pending')
  // Parse step: jobs in 'pending' status explicitly marked 'ready_to_parse' by the user
  // 'links_collected' stage is intentionally skipped — user must confirm parse step
  const { data: pending } = await db
    .from('yandex_maps_jobs')
    .select('id, progress_stage')
    .eq('status', 'pending')
    .in('progress_stage', ['pending', 'ready_to_parse'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const stage = (pending.progress_stage as string) === 'ready_to_parse' ? 'parse' : 'collect';
  return { id: pending.id as string, stage };
}

async function claimEmailValidationJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('email_validation_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;
  return pending.id as string;
}

// --------------------------------------------------------------------------
// Single poll tick — tries to pick up one job of any type
// --------------------------------------------------------------------------

async function pollOnce(): Promise<boolean> {
  if (!supabaseAdmin) return false;

  // Try each job type in order; run the first one found
  const hhJobId = await claimHHJob();
  if (hhJobId) {
    log('info', `Running HH parser job ${hhJobId}`);
    await runHHParserJob(hhJobId);
    return true;
  }

  const searchJobId = await claimSearchJob();
  if (searchJobId) {
    log('info', `Running search parser job ${searchJobId}`);
    await runSearchParserJob(searchJobId);
    return true;
  }

  const enrichJobId = await claimEnrichJob();
  if (enrichJobId) {
    log('info', `Running website enrichment job ${enrichJobId}`);
    await runWebsiteEnrichmentJob(enrichJobId);
    return true;
  }

  const ymJob = await claimYandexMapsJob();
  if (ymJob) {
    if (ymJob.stage === 'collect') {
      log('info', `Running YandexMaps collect-links job ${ymJob.id}`);
      await runYandexMapsCollectLinks(ymJob.id);
    } else {
      log('info', `Running YandexMaps parse-orgs job ${ymJob.id}`);
      await runYandexMapsParseOrganizations(ymJob.id);
    }
    return true;
  }

  const evJobId = await claimEmailValidationJob();
  if (evJobId) {
    log('info', `Running email validation job ${evJobId}`);
    await runEmailValidationJob(evJobId);
    return true;
  }

  return false;
}

// --------------------------------------------------------------------------
// Main polling loop
// --------------------------------------------------------------------------

async function pollLoop(): Promise<void> {
  log('info', 'Polling loop started');

  while (!shuttingDown) {
    try {
      const found = await pollOnce();
      if (!found) {
        // Nothing to do — wait before next poll
        await sleep(POLL_INTERVAL_MS);
      }
      // If a job was found and executed, immediately poll again (more might be waiting)
    } catch (err) {
      log('error', 'Unexpected error in poll loop', err);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  log('info', 'Poll loop exited (shutting down)');
}

// --------------------------------------------------------------------------
// Graceful shutdown
// --------------------------------------------------------------------------

function setupGracefulShutdown() {
  const onSignal = (sig: string) => {
    log('info', `Received ${sig}, stopping after current job completes...`);
    shuttingDown = true;
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log('info', `Starting Portal worker (pid=${process.pid})`);

  if (!supabaseAdmin) {
    log('error', 'SUPABASE_SERVICE_ROLE_KEY is not set — worker cannot start');
    process.exit(1);
  }

  setupGracefulShutdown();

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  await pollLoop();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
