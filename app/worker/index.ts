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
import { runYandexDirectJob } from '@/lib/parsers/yandexDirect/runner';
import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';
import { recoverStalePreparingWebsiteEnrichmentJobs } from '@/lib/enrich/websiteEnrichmentJobPublisher';
import { runBriefScoringJob } from '@/lib/briefScoring/briefScoringWorker';
import { runYandexMapsCollectLinks, runYandexMapsParseOrganizations } from '@/lib/parsers/yandexMapsWorker';
import { runEmailValidationJob } from '@/lib/emailValidation/emailValidationWorker';
import { runInnEnrichJob } from '@/lib/innEnrich/runJob';
import { runBugorSmtpValidation } from '@/lib/bugorOutreach/smtpValidationWorker';
import { runNashSmtpValidation } from '@/lib/nashOutreach/smtpValidationWorker';
import { collectRawSignals } from '@/lib/nashOutreach/collectLeads';
import { enrichRawSignals } from '@/lib/nashOutreach/enrichLeads';
import { findEmailsForLeads } from '@/lib/bugorOutreach/findEmails';
import { validateLeadEmails } from '@/lib/bugorOutreach/validateEmails';
import { runLeadImportJob } from '@/lib/cisLeads/leadImportWorker';
import { runPhoneEnrichmentBatch } from '@/lib/cisLeads/phoneEnrichmentWorker';
import { runContactAggregationBatch } from '@/lib/cisLeads/contactAggregationWorker';
import { pollAndQualifyReplies } from '@/lib/instantly/leadQualificationWorker';
import { syncInstantlyCampaignAnalytics } from '@/lib/tools/instantlyCampaignCatalog';
import { syncClientLeads } from '@/lib/instantly/clientLeadsSync';
import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';
import { runDeadlineNotifications } from '@/lib/notifications/deadlineCron';
import { runLeadEscalation } from '@/lib/notifications/leadEscalation';
import { runTechRenewalNotifications } from '@/lib/notifications/techRenewalCron';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const LI_CAMPAIGN_TICK_INTERVAL_MS = Number(process.env.LI_CAMPAIGN_TICK_INTERVAL_MS ?? String(5 * 60 * 1000));
const DEADLINE_NOTIFICATIONS_INTERVAL_MS = Number(
  process.env.DEADLINE_NOTIFICATIONS_INTERVAL_MS ?? String(10 * 60 * 1000),
);
const HH_DRAIN_TIMEOUT_MS = Number(process.env.WORKER_DRAIN_TIMEOUT_MINUTES ?? '180') * 60 * 1000;
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

// Interval for syncing Instantly campaign analytics to DB (used by client portal).
// Default: 1 hour. Runs in parallel with the job poll loop.
const ANALYTICS_SYNC_INTERVAL_MS = Number(process.env.WORKER_ANALYTICS_SYNC_INTERVAL_MS ?? String(60 * 60 * 1000));

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

  try {
    const preparingCutoff = new Date(
      Date.now() - Number(process.env.ENRICH_PREPARING_STALE_MINUTES ?? '15') * 60_000,
    ).toISOString();
    const preparingRecovery = await recoverStalePreparingWebsiteEnrichmentJobs(db, preparingCutoff);
    if (preparingRecovery.published || preparingRecovery.failed) {
      log(
        'warn',
        `Recovered stale preparing website jobs: published=${preparingRecovery.published}, failed=${preparingRecovery.failed}`,
      );
    }
  } catch (preparingError) {
    log('warn', 'Stale preparing website job recovery failed', preparingError);
  }

  // Brief scoring — сбрасываем в 'pending' (воркер сам продолжит с места остановки)
  const { data: briefJobs, error: briefErr } = await db
    .from('brief_scoring_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (briefErr) log('warn', 'Startup recovery: brief_scoring_jobs update failed', briefErr);
  else if (briefJobs?.length) log('info', `Startup recovery: reset ${briefJobs.length} brief_scoring_jobs to pending`);

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

  const { data: innJobs, error: innErr } = await db
    .from('inn_enrich_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (innErr) log('warn', 'Startup recovery: inn_enrich_jobs update failed', innErr);
  else if (innJobs?.length) log('info', `Startup recovery: reset ${innJobs.length} inn_enrich_jobs to pending`);

  // Yandex Direct parser — сбрасываем 'processing' в 'pending'. Полный
  // повтор безопасен: дедуп по UNIQUE(job_id, domain) не даст дублей строк
  // (повторный прогон лишь заново тратит XMLStock-запросы).
  const { data: ydJobs, error: ydErr } = await db
    .from('yandex_direct_jobs')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .select('id');
  if (ydErr) log('warn', 'Startup recovery: yandex_direct_jobs update failed', ydErr);
  else if (ydJobs?.length) log('info', `Startup recovery: reset ${ydJobs.length} yandex_direct_jobs to pending`);
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

  const { data: claimed } = await db
    .from('website_enrichment_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function claimYandexMapsJob(): Promise<{ id: string; stage: 'collect' | 'parse' } | null> {
  const db = supabaseAdmin!;

  // Collect-links step: jobs in 'pending' status with initial stage ('pending')
  //   → after collecting, automatically continues to parse-orgs within the same run
  // Parse step: jobs in 'pending' + 'ready_to_parse' — manual re-parse of existing links
  const { data: pending } = await db
    .from('yandex_maps_jobs')
    .select('id, progress_stage')
    .eq('status', 'pending')
    .in('progress_stage', ['pending', 'ready_to_parse'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('yandex_maps_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .eq('progress_stage', pending.progress_stage)
    .select('id, progress_stage')
    .maybeSingle();

  if (!claimed) return null;

  const stage = (claimed.progress_stage as string) === 'ready_to_parse' ? 'parse' : 'collect';
  return { id: claimed.id as string, stage };
}

async function claimBriefScoringJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('brief_scoring_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('brief_scoring_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
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

  const { data: claimed } = await db
    .from('email_validation_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id as string ?? null;
}

async function claimInnEnrichJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('inn_enrich_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('inn_enrich_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id as string ?? null;
}

async function claimLeadImportJob(): Promise<string | null> {
  const db = supabaseAdmin!;

  const { data: pending } = await db
    .from('lead_import_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('lead_import_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function claimYandexDirectJob(): Promise<string | null> {
  const db = supabaseAdmin!;

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

// --------------------------------------------------------------------------
// RDP booking expiry — marks bookings as 'expired' when starts_at + 5 min
// has passed without an active session being started.
// --------------------------------------------------------------------------

async function checkRdpBookingExpiry(): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: expired, error } = await db
    .from('rdp_bookings')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('starts_at', fiveMinAgo)
    .select('id');

  if (error) {
    log('warn', 'RDP booking expiry check failed', error);
  } else if (expired?.length) {
    log('info', `Expired ${expired.length} RDP booking(s) (no-show after 5 min)`);
  }
}

// --------------------------------------------------------------------------
// RDP session inactivity — auto-ends sessions idle for 30+ minutes.
// Safety net for closed tabs / browser crashes where the frontend can't
// call DELETE /sessions itself.
// --------------------------------------------------------------------------

const RDP_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

async function checkRdpSessionInactivity(): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const cutoff = new Date(Date.now() - RDP_INACTIVITY_TIMEOUT_MS).toISOString();
  const now = new Date().toISOString();

  const { data: ended, error } = await db
    .from('rdp_sessions')
    .update({ status: 'ended', ended_at: now })
    .eq('status', 'active')
    .lt('last_activity_at', cutoff)
    .select('id, user_id');

  if (error) {
    log('warn', 'RDP session inactivity check failed', error);
  } else if (ended?.length) {
    log('info', `Auto-ended ${ended.length} RDP session(s) due to 30 min inactivity`);
  }
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
    await runHHParserJob(hhJobId, HH_DRAIN_TIMEOUT_MS);
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

  const briefScoringJobId = await claimBriefScoringJob();
  if (briefScoringJobId) {
    log('info', `Running brief scoring job ${briefScoringJobId}`);
    await runBriefScoringJob(briefScoringJobId);
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

  const innJobId = await claimInnEnrichJob();
  if (innJobId) {
    log('info', `Running inn-enrich job ${innJobId}`);
    await runInnEnrichJob(innJobId);
    return true;
  }

  try {
    const bugorCount = await runBugorSmtpValidation();
    if (bugorCount > 0) {
      log('info', `Bugor SMTP validation processed ${bugorCount} lead(s)`);
      return true;
    }
  } catch (err) {
    log('warn', 'Bugor SMTP validation failed', err);
  }

  try {
    const nashCount = await runNashSmtpValidation();
    if (nashCount > 0) {
      log('info', `Nash SMTP validation processed ${nashCount} lead(s)`);
      return true;
    }
  } catch (err) {
    log('warn', 'Nash SMTP validation failed', err);
  }

  const leadImportJobId = await claimLeadImportJob();
  if (leadImportJobId) {
    log('info', `Running lead import job ${leadImportJobId}`);
    await runLeadImportJob(leadImportJobId);
    return true;
  }

  const yandexDirectJobId = await claimYandexDirectJob();
  if (yandexDirectJobId) {
    log('info', `Running Yandex Direct job ${yandexDirectJobId}`);
    await runYandexDirectJob(supabaseAdmin, yandexDirectJobId);
    return true;
  }

  // Instantly lead qualification: poll Instantly API for new reply emails and qualify via AI
  try {
    const qualCount = await pollAndQualifyReplies();
    if (qualCount > 0) {
      log('info', `Instantly lead qualification processed ${qualCount} reply(s)`);
      return true;
    }
  } catch (err) {
    log('warn', 'Instantly lead qualification poll failed', err);
  }

  // Low-priority continuous enrichment: probe phones for Telegram identity.
  // Runs in small batches to avoid rate limits.
  try {
    const out = await runPhoneEnrichmentBatch();
    if (out.processed > 0) {
      log('info', `Phone enrichment processed ${out.processed} phone(s)`);
      return true;
    }
  } catch (err) {
    log('warn', 'Phone enrichment batch failed', err);
  }

  try {
    const out = await runContactAggregationBatch();
    if (out.processed > 0) {
      log('info', `Contact aggregation processed ${out.processed} item(s)`);
      return true;
    }
  } catch (err) {
    log('warn', 'Contact aggregation batch failed', err);
  }

  return false;
}

// --------------------------------------------------------------------------
// Main polling loop (Realtime-aware)
// --------------------------------------------------------------------------

const REALTIME_TABLES = [
  'parser_jobs',
  'search_parser_jobs',
  'website_enrichment_jobs',
  'brief_scoring_jobs',
  'yandex_maps_jobs',
  'email_validation_jobs',
  'inn_enrich_jobs',
  'lead_import_jobs',
  'yandex_direct_jobs',
];
const FALLBACK_POLL_MS = 30_000;

function createWaiter(timeoutMs: number) {
  let resolve: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  const timer = setTimeout(() => resolve!(), timeoutMs);
  const wake = () => { clearTimeout(timer); resolve!(); };
  const cleanup = () => clearTimeout(timer);
  return { promise, wake, cleanup };
}

async function pollLoop(): Promise<void> {
  const effectiveFallback = Math.max(POLL_INTERVAL_MS, FALLBACK_POLL_MS);
  let currentWaiter: ReturnType<typeof createWaiter> | null = null;

  let channel: import('@supabase/supabase-js').RealtimeChannel | null = null;
  if (supabaseAdmin) {
    channel = supabaseAdmin.channel('worker_all_jobs');
    for (const table of REALTIME_TABLES) {
      channel = channel.on(
        'postgres_changes' as 'postgres_changes',
        { event: 'INSERT', schema: 'public', table, filter: 'status=eq.pending' },
        () => { currentWaiter?.wake(); },
      );
      channel = channel.on(
        'postgres_changes' as 'postgres_changes',
        { event: 'UPDATE', schema: 'public', table, filter: 'status=eq.pending' },
        () => { currentWaiter?.wake(); },
      );
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') log('info', 'Realtime subscribed to job tables');
      else if (status === 'CHANNEL_ERROR') log('warn', `Realtime error — fallback to ${effectiveFallback}ms polling`);
    });
  }

  log('info', `Poll loop started (realtime + ${effectiveFallback}ms fallback)`);

  while (!shuttingDown) {
    try {
      await checkRdpBookingExpiry();
      await checkRdpSessionInactivity();

      const found = await pollOnce();
      if (!found) {
        if (channel) {
          currentWaiter = createWaiter(effectiveFallback);
          await currentWaiter.promise;
          currentWaiter = null;
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
      }
    } catch (err) {
      log('error', 'Unexpected error in poll loop', err);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (channel) {
    currentWaiter?.cleanup();
    await supabaseAdmin!.removeChannel(channel);
    log('info', 'Realtime channel removed');
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

// --------------------------------------------------------------------------
// Periodic sync (Instantly → DB) — runs independently of jobs
// --------------------------------------------------------------------------

async function analyticsSync(): Promise<void> {
  try {
    log('info', 'Syncing Instantly campaign analytics to DB...');
    const { rows } = await syncInstantlyCampaignAnalytics();
    log('info', `Analytics sync done: ${rows} campaign(s) updated`);
  } catch (err) {
    log('warn', 'Analytics sync failed', err);
  }
}

async function clientLeadsSync(): Promise<void> {
  try {
    log('info', 'Syncing client campaign leads from Instantly...');
    const { campaigns, leads } = await syncClientLeads();
    log('info', `Client leads sync done: ${campaigns} campaign(s), ${leads} lead(s)`);
  } catch (err) {
    log('warn', 'Client leads sync failed', err);
  }
}

async function periodicSyncLoop(): Promise<void> {
  await analyticsSync();
  await clientLeadsSync();

  while (!shuttingDown) {
    await sleep(ANALYTICS_SYNC_INTERVAL_MS);
    if (shuttingDown) break;
    await analyticsSync();
    await clientLeadsSync();
  }
}

// --------------------------------------------------------------------------
// LinkedIn Outreach campaign tick loop
// --------------------------------------------------------------------------

async function liCampaignTickLoop(): Promise<void> {
  while (!shuttingDown) {
    await sleep(LI_CAMPAIGN_TICK_INTERVAL_MS);
    if (shuttingDown) break;

    if (!supabaseAdmin) continue;

    try {
      const { data: campaigns, error } = await supabaseAdmin
        .from('li_campaigns')
        .select('id, user_id, name')
        .eq('status', 'running')
        .order('updated_at', { ascending: true });

      if (error) {
        log('warn', `LI campaigns fetch failed: ${error.message}`);
        continue;
      }
      if (!campaigns || campaigns.length === 0) continue;

      log('info', `Processing ${campaigns.length} LinkedIn campaign(s)`);
      for (const c of campaigns) {
        try {
          const result = await runCampaignTick(c.id as string, c.user_id as string);
          if (result.processed > 0 || result.errors > 0) {
            log('info', `LI campaign "${c.name}": processed=${result.processed}, errors=${result.errors}`);
          }
        } catch (err) {
          log('error', `LI campaign "${c.name}" (${c.id}) tick failed`, err);
        }
      }
    } catch (err) {
      log('error', 'LI campaign tick loop error', err);
    }
  }
}

// --------------------------------------------------------------------------
// Deadline-driven notifications (replaces Vercel Cron in self-hosted setup)
// --------------------------------------------------------------------------

async function deadlineNotificationsLoop(): Promise<void> {
  // Run immediately on startup, then on a fixed interval. Keeps parity with
  // the previous Vercel Cron schedule (`*/10 * * * *`).
  const tick = async () => {
    if (!supabaseAdmin) return;
    const now = new Date();
    try {
      const deadline = await runDeadlineNotifications({ db: supabaseAdmin, now });
      if (deadline.created > 0) {
        log('info', `Deadline notifications: processed=${deadline.processed}, created=${deadline.created}`);
      }
    } catch (err) {
      log('error', 'Deadline notifications tick failed', err);
    }
    try {
      const lead = await runLeadEscalation({ db: supabaseAdmin, now });
      if (lead.created > 0) {
        log('info', `Lead escalation: created=${lead.created}`);
      }
    } catch (err) {
      log('error', 'Lead escalation tick failed', err);
    }
    try {
      const techRenewals = await runTechRenewalNotifications({ db: supabaseAdmin, now: new Date() });
      if (techRenewals.created) {
        log('info', `tech renewal notifications created: ${techRenewals.created}`);
      }
    } catch (err) {
      log('error', 'Tech renewal notifications tick failed', err);
    }
  };

  await tick();
  while (!shuttingDown) {
    await sleep(DEADLINE_NOTIFICATIONS_INTERVAL_MS);
    if (shuttingDown) break;
    await tick();
  }
}

// --------------------------------------------------------------------------
// Scheduled Nash Outreach collection (daily at 07:00 Moscow time = 04:00 UTC)
// --------------------------------------------------------------------------

const NASH_COLLECT_HOUR_UTC = Number(process.env.NASH_COLLECT_HOUR_UTC ?? '4');

function getNextRunMs(hourUtc: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runNashCollect(): Promise<void> {
  if (!supabaseAdmin) return;
  log('info', 'Nash Outreach scheduled collection starting...');

  try {
    const rawItems = await collectRawSignals();
    log('info', `Nash collect: ${rawItems.length} raw items`);
    if (rawItems.length === 0) return;

    const enriched = await enrichRawSignals(rawItems);
    log('info', `Nash collect: ${enriched.length} enriched leads`);
    if (enriched.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabaseAdmin
      .from('nash_outreach_leads')
      .select('company_name, website')
      .gte('batch_date', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));

    const existingKeys = new Set(
      (existing ?? []).map((r: { company_name?: string; website?: string }) =>
        `${(r.company_name ?? '').toLowerCase()}|${(r.website ?? '').toLowerCase()}`),
    );

    const toInsert = enriched.filter((lead) => {
      const key = `${lead.company_name.toLowerCase()}|${(lead.website ?? '').toLowerCase()}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });

    if (toInsert.length === 0) {
      log('info', 'Nash collect: all leads were duplicates');
      return;
    }

    const rows = toInsert.map((lead) => ({
      batch_date: today,
      company_name: lead.company_name,
      website: lead.website,
      city: lead.city,
      employee_count: lead.employee_count,
      description: lead.description,
      niche: lead.niche,
      signal_type: lead.signal_type,
      signal_detail: lead.signal_detail,
      intent_score: lead.intent_score,
      priority: lead.priority,
      outreach_angle: lead.outreach_angle,
      source_url: lead.source_url,
      hh_employer_id: lead.hh_employer_id,
      hh_vacancy_name: lead.hh_vacancy_name,
      raw_data: { source: lead.source_url },
    }));

    const { data: insertedRows, error: insertError } = await supabaseAdmin
      .from('nash_outreach_leads')
      .insert(rows)
      .select('id, company_name, website, source_url, emails_found');

    if (insertError) {
      log('error', `Nash collect insert error: ${insertError.message}`);
      return;
    }

    const leads = insertedRows ?? [];
    log('info', `Nash collect: inserted ${leads.length} leads`);

    const emailResults = await findEmailsForLeads(
      leads.map((l: { id: string; company_name: string; website?: string | null; source_url?: string | null }) => ({
        id: l.id, company_name: l.company_name, website: l.website ?? null,
        founder_name: null, source_url: l.source_url ?? null,
      })),
    );

    let emailsFound = 0;
    for (const er of emailResults) {
      if (er.emails.length > 0) {
        emailsFound++;
        await supabaseAdmin.from('nash_outreach_leads')
          .update({ emails_found: er.emails, smtp_tier: er.tier }).eq('id', er.id);
      } else {
        await supabaseAdmin.from('nash_outreach_leads')
          .update({ smtp_status: 'skipped' }).eq('id', er.id);
      }
    }

    const leadsWithEmails = emailResults.filter((er) => er.emails.length > 0);
    if (leadsWithEmails.length > 0) {
      const validationResults = await validateLeadEmails(
        leadsWithEmails.map((er) => ({ id: er.id, emails: er.emails })),
      );
      let validated = 0;
      for (const vr of validationResults) {
        if (vr.validated.length > 0) {
          validated++;
          await supabaseAdmin.from('nash_outreach_leads')
            .update({ emails_validated: vr.validated, smtp_status: 'pending' }).eq('id', vr.id);
        } else {
          await supabaseAdmin.from('nash_outreach_leads')
            .update({ smtp_status: 'skipped' }).eq('id', vr.id);
        }
      }
      log('info', `Nash collect: emails found=${emailsFound}, MX validated=${validated}`);
    }

    log('info', 'Nash collect complete (SMTP + sequences + upload handled by worker poll loop)');
  } catch (err) {
    log('error', 'Nash collect failed', err);
  }
}

async function nashCollectScheduler(): Promise<void> {
  while (!shuttingDown) {
    const waitMs = getNextRunMs(NASH_COLLECT_HOUR_UTC);
    const nextRun = new Date(Date.now() + waitMs).toISOString();
    log('info', `Nash collect: next run at ${nextRun} (in ${Math.round(waitMs / 60_000)} min)`);
    await sleep(waitMs);
    if (shuttingDown) break;
    await runNashCollect();
  }
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

  // Start periodic sync loop in the background (does not block job processing).
  void periodicSyncLoop();

  // Start Nash Outreach daily collection scheduler (default 04:00 UTC = 07:00 MSK).
  void nashCollectScheduler();

  // Start LinkedIn Outreach campaign tick loop (every 5 min by default).
  void liCampaignTickLoop();

  // Start deadline-notifications loop (every 10 min by default).
  void deadlineNotificationsLoop();

  await pollLoop();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
