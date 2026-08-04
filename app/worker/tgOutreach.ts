import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runCampaignLoop, refetchEmptyDialogs } from '@/lib/tgOutreach/campaignLoop';
import { runWarmupLoop } from '@/lib/tgOutreach/warmup/loop';
import { writeHeartbeat } from '@/lib/tgOutreach/gramClient';
import { startTrace } from '@/lib/tracer';

const WORKER_ID = `tg-outreach-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const _MAX_CONCURRENCY = Number(process.env.TG_OUTREACH_MAX_CONCURRENCY ?? '5');

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

const runningCampaigns = new Map<string, { stop: () => void; promise: Promise<void> }>();

// Per-campaign last-progress timestamps. Each campaign loop calls onProgress()
// in its hot spots (top of while iteration, before each account, after each
// account pause). If a campaign stops reporting progress for longer than the
// watchdog threshold, we force-exit the process so docker/autoheal can restart
// us. This catches "container healthy but main loop frozen" scenarios — the
// May 10 incident: worker hung 35 hours after a single "Пауза 211 сек" log
// line, autoheal didn't react because the independent heartbeat setInterval
// kept the container green.
const campaignLastProgressAt = new Map<string, number>();
const WATCHDOG_THRESHOLD_MS = Number(process.env.TG_OUTREACH_WATCHDOG_MS) || 15 * 60_000;
const WATCHDOG_CHECK_INTERVAL_MS = 60_000;

async function resetStuckJobs() {
  const { data } = await db
    .from('tg_outreach_jobs')
    .select('id')
    .eq('status', 'running');

  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to pending`);
    await db
      .from('tg_outreach_jobs')
      .update({ status: 'pending', error_message: null, started_at: null, finished_at: null })
      .eq('status', 'running');
  }
}

// Control-джобы (stop/restart/refetch_messages) не занимают слот в
// runningCampaigns и должны подхватываться независимо от concurrency-limit —
// иначе оператор жмёт «Стоп», но при 5/5 занятых слотах джоб живёт в pending
// до истечения (см. resumeRunningCampaigns:249 — auto-completes stale через
// 5 мин). Инцидент 29.07.2026: 5 running кампаний → 4 стоп-клика подряд ушли
// в stale, кампании продолжали работать.
export const CONTROL_ACTIONS = ['stop', 'restart', 'refetch_messages', 'warmup_stop'] as const;
export const START_ACTIONS = ['start', 'warmup_start'] as const;

export async function claimJob(
  actionFilter?: readonly string[],
): Promise<{ id: string; campaign_id: string; action: string } | null> {
  let pendingQuery = db
    .from('tg_outreach_jobs')
    .select('id, campaign_id, action')
    .eq('status', 'pending');
  if (actionFilter && actionFilter.length > 0) {
    pendingQuery = pendingQuery.in('action', actionFilter as unknown as string[]);
  }
  const { data: pending } = await pendingQuery
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_outreach_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, campaign_id, action')
    .maybeSingle();

  return claimed ?? null;
}

async function handleStartJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  if (runningCampaigns.has(campaignId)) {
    if (shouldStop()) {
      log('info', `Campaign ${campaignId} already running and worker is shutting down — re-queueing job for next worker`);
      await db.from('tg_outreach_jobs').update({ status: 'pending', started_at: null }).eq('id', job.id);
    } else {
      log('warn', `Campaign ${campaignId} already running, skipping start`);
      await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    }
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  const { data: campaign } = await db
    .from('tg_outreach_campaigns')
    .select('name, user_id')
    .eq('id', campaignId)
    .single();

  const trace = await startTrace({
    name: 'tg-outreach.campaign.run',
    input: {
      campaignId,
      campaignName: campaign?.name,
      route: 'tg_outreach_worker',
      userId: campaign?.user_id,
    },
    message: `TG Аутрич: ${campaign?.name ?? campaignId}`,
    userId: campaign?.user_id ?? null,
  });

  const requestId = trace?.traceId ?? crypto.randomUUID();
  if (trace) {
    await db
      .from('trace_spans')
      .update({ input: { campaignId, campaignName: campaign?.name, requestId, route: 'tg_outreach_worker', userId: campaign?.user_id } })
      .eq('id', trace.id);
  }

  const traceContext = trace ? { requestId } : undefined;

  campaignLastProgressAt.set(campaignId, Date.now());
  const onProgress = () => { campaignLastProgressAt.set(campaignId, Date.now()); };

  const promise = runCampaignLoop(campaignId, db, () => shouldStop() || stopRequested, traceContext, onProgress)
    .then(() => {
      log('info', `Campaign ${campaignId} loop finished`);
      void trace?.end({ status: 'stopped' });
    })
    .catch((err) => {
      log('error', `Campaign ${campaignId} loop error: ${err instanceof Error ? err.message : String(err)}`);
      db.from('tg_outreach_campaigns').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', campaignId).then(({ error }) => {
        if (error) log('error', `Failed to mark tg campaign ${campaignId} as error: ${error.message}`);
      }, () => {});
      void trace?.fail(err);
    })
    .finally(() => {
      runningCampaigns.delete(campaignId);
      campaignLastProgressAt.delete(campaignId);
      db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id).then(({ error }) => {
        if (error) log('error', `Failed to mark tg job ${job.id} as completed: ${error.message}`);
      }, () => {});
    });

  runningCampaigns.set(campaignId, { stop: stopFn, promise });
  log('info', `Started campaign ${campaignId}`);
}

async function handleStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;
  const running = runningCampaigns.get(campaignId);

  if (running) {
    await db
      .from('tg_outreach_campaigns')
      .update({ status: 'stopped', updated_at: new Date().toISOString() })
      .eq('id', campaignId);
    running.stop();
    log('info', `Signaled stop for campaign ${campaignId}`);
    await running.promise;
  } else {
    await db.from('tg_outreach_campaigns').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', campaignId);
  }

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function handleRestartJob(job: { id: string; campaign_id: string }) {
  await handleStopJob(job);
  await handleStartJob(job);
}

async function handleRefetchJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;
  log('info', `Refetch messages for campaign ${campaignId}`);

  try {
    await refetchEmptyDialogs(campaignId, db, undefined, async (p) => {
      await db.from('tg_outreach_jobs').update({ progress: p }).eq('id', job.id);
    });
    await db.from('tg_outreach_jobs').update({
      status: 'completed',
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('error', `Refetch failed for ${campaignId}: ${errMsg}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: errMsg,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

/**
 * Прогрев кампании. Занимает тот же слот в runningCampaigns, что и боевой цикл,
 * — так прогрев и аутрич не могут идти по одной кампании одновременно, а
 * сторожевой таймер следит за прогревом ровно как за обычной кампанией.
 */
async function handleWarmupStartJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  if (runningCampaigns.has(campaignId)) {
    if (shouldStop()) {
      log('info', `Warmup for ${campaignId} already running and worker is shutting down — re-queueing`);
      await db.from('tg_outreach_jobs').update({ status: 'pending', started_at: null }).eq('id', job.id);
    } else {
      log('warn', `Campaign ${campaignId} is already busy, skipping warmup start`);
      await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    }
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  campaignLastProgressAt.set(campaignId, Date.now());
  const onProgress = () => { campaignLastProgressAt.set(campaignId, Date.now()); };

  const promise = runWarmupLoop(campaignId, db, () => shouldStop() || stopRequested, onProgress)
    .then(() => {
      log('info', `Warmup for campaign ${campaignId} finished`);
    })
    .catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('error', `Warmup for campaign ${campaignId} failed: ${errMsg}`);
      db.from('tg_outreach_warmup_runs')
        .update({ status: 'failed', error_message: errMsg, finished_at: new Date().toISOString() })
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'running'])
        .then(({ error }) => {
          if (error) log('error', `Failed to mark warmup run failed for ${campaignId}: ${error.message}`);
        }, () => {});
      // Иначе кампания застрянет в статусе «прогрев», из которого нельзя
      // запустить аутрич.
      db.from('tg_outreach_campaigns')
        .update({ status: 'stopped', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('status', 'warming')
        .then(() => {}, () => {});
    })
    .finally(() => {
      runningCampaigns.delete(campaignId);
      campaignLastProgressAt.delete(campaignId);
      db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id).then(({ error }) => {
        if (error) log('error', `Failed to mark tg job ${job.id} as completed: ${error.message}`);
      }, () => {});
    });

  runningCampaigns.set(campaignId, { stop: stopFn, promise });
  log('info', `Started warmup for campaign ${campaignId}`);
}

async function handleWarmupStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  // Статус ставим ДО сигнала остановки: цикл перечитывает run из БД на каждом
  // проходе и должен увидеть, что активного прогрева больше нет.
  await db
    .from('tg_outreach_warmup_runs')
    .update({ status: 'stopped', finished_at: new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'running']);

  const running = runningCampaigns.get(campaignId);
  if (running) {
    running.stop();
    log('info', `Signaled warmup stop for campaign ${campaignId}`);
    await running.promise;
  }

  // Возвращаем кампанию в «остановлена»: прогрев кончился, аутрич снова можно
  // запустить. Условие на warming — чтобы не затереть статус, если кампанию
  // тем временем уже перевели во что-то другое.
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('status', 'warming');

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function dispatchJob(job: { id: string; campaign_id: string; action: string }): Promise<void> {
  log('info', `Claimed job ${job.id}: ${job.action} for campaign ${job.campaign_id}`);
  try {
    switch (job.action) {
      case 'start':
        await handleStartJob(job);
        break;
      case 'stop':
        await handleStopJob(job);
        break;
      case 'restart':
        await handleRestartJob(job);
        break;
      case 'refetch_messages':
        await handleRefetchJob(job);
        break;
      case 'warmup_start':
        await handleWarmupStartJob(job);
        break;
      case 'warmup_stop':
        await handleWarmupStopJob(job);
        break;
      default:
        log('warn', `Unknown action: ${job.action}`);
        await db.from('tg_outreach_jobs').update({
          status: 'failed',
          error_message: `Unknown action: ${job.action}`,
          finished_at: new Date().toISOString(),
        }).eq('id', job.id);
    }
  } catch (err) {
    log('error', `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

export async function pollOnce(): Promise<boolean> {
  // Всегда сначала пытаемся подхватить control-джобы (stop/restart/refetch):
  // они не занимают слот в runningCampaigns, а stop даже освобождает его.
  // Если ждать освобождения concurrency-slot'а перед стопом — оператор
  // не может выключить ничего, когда все слоты заняты.
  const controlJob = await claimJob(CONTROL_ACTIONS);
  if (controlJob) {
    await dispatchJob(controlJob);
    return true;
  }

  if (runningCampaigns.size >= _MAX_CONCURRENCY) {
    log(
      'info',
      `Max concurrent campaigns reached (${runningCampaigns.size}/${_MAX_CONCURRENCY}), waiting for free slot`,
    );
    return false;
  }

  const startJob = await claimJob(START_ACTIONS);
  if (!startJob) return false;

  await dispatchJob(startJob);
  return true;
}

export async function resumeRunningCampaigns() {
  // On worker boot, also rescue campaigns stuck in `error` from previous runs
  // (e.g. transient DB/proxy/network outages that flipped status to error and
  // then got cleared, but nothing brought the campaigns back).
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('status', 'error');

  const { data: running } = await db
    .from('tg_outreach_campaigns')
    .select('id, user_id')
    .in('status', ['running', 'paused']);

  if (!running?.length) return;

  const campaignIds = running.map(c => c.id);
  // During deploy drain/restart we can end up with stale stop/restart jobs
  // that would immediately kill auto-resumed campaigns on next worker boot.
  await db
    .from('tg_outreach_jobs')
    .update({
      status: 'completed',
      finished_at: new Date().toISOString(),
      error_message: 'Auto-completed stale stop/restart job during worker resume',
    })
    .in('campaign_id', campaignIds)
    .in('action', ['stop', 'restart'])
    .in('status', ['pending', 'running']);

  log('info', `Found ${running.length} campaigns with status running/paused, scheduling auto-resume`);
  for (const campaign of running) {
    // There may already be duplicate active start jobs left by an older
    // worker/deploy race. Limit the existence check to one row: maybeSingle()
    // returns an error (and null data) when multiple rows match, which used to
    // make this loop enqueue one more duplicate every five minutes.
    const { data: existingJob, error: existingJobError } = await db
      .from('tg_outreach_jobs')
      .select('id')
      .eq('campaign_id', campaign.id)
      .eq('action', 'start')
      .in('status', ['pending', 'running'])
      .limit(1)
      .maybeSingle();

    if (existingJobError) {
      throw new Error(
        `Failed to check active start job for campaign ${campaign.id}: ${existingJobError.message}`,
      );
    }

    if (!existingJob) {
      const { error: insertError } = await db.from('tg_outreach_jobs').insert({
        campaign_id: campaign.id,
        user_id: campaign.user_id ?? '00000000-0000-0000-0000-000000000000',
        action: 'start',
        status: 'pending',
      });

      // A partial unique index is the final race guard. A concurrent resume
      // check may win the insert after our existence check; that is already
      // the desired state, so treat only that conflict as benign.
      if (insertError?.code === '23505') {
        log('info', `Active start job already exists for campaign ${campaign.id}`);
        continue;
      }
      if (insertError) {
        throw new Error(
          `Failed to queue auto-resume for campaign ${campaign.id}: ${insertError.message}`,
        );
      }

      log('info', `Queued auto-resume start job for campaign ${campaign.id}`);
    }
  }

  // Обновляем paused → running, т.к. start job уже в очереди
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('status', 'paused');
}

/**
 * Возобновить прогревы после перезапуска процесса.
 *
 * Прогрев идёт 3-4 дня, то есть переживает несколько деплоев и срабатываний
 * сторожевого таймера. Статус кампании при этом остаётся `stopped` (прогрев —
 * не боевой цикл), поэтому обычный auto-resume его не подхватывает, и без этой
 * функции прогрев после первого же рестарта тихо умер бы на середине.
 */
export async function resumeWarmupRuns() {
  const { data: runs } = await db
    .from('tg_outreach_warmup_runs')
    .select('id, campaign_id')
    .in('status', ['pending', 'running']);
  if (!runs?.length) return;

  for (const run of runs as Array<{ id: string; campaign_id: string }>) {
    if (runningCampaigns.has(run.campaign_id)) continue;

    const { data: existingJob } = await db
      .from('tg_outreach_jobs')
      .select('id')
      .eq('campaign_id', run.campaign_id)
      .eq('action', 'warmup_start')
      .in('status', ['pending', 'running'])
      .limit(1)
      .maybeSingle();
    if (existingJob) continue;

    const { data: campaign } = await db
      .from('tg_outreach_campaigns')
      .select('user_id')
      .eq('id', run.campaign_id)
      .maybeSingle();

    const { error: insertError } = await db.from('tg_outreach_jobs').insert({
      campaign_id: run.campaign_id,
      user_id: (campaign as { user_id?: string } | null)?.user_id ?? '00000000-0000-0000-0000-000000000000',
      action: 'warmup_start',
      status: 'pending',
    });
    if (insertError) {
      log('error', `Failed to queue warmup resume for campaign ${run.campaign_id}: ${insertError.message}`);
      continue;
    }
    log('info', `Queued warmup resume for campaign ${run.campaign_id}`);
  }
}

const RESUME_CHECK_INTERVAL_MS = 5 * 60_000;

async function main() {
  log('info', 'TG Outreach worker starting...');
  await resetStuckJobs();
  await resumeRunningCampaigns();
  await resumeWarmupRuns();

  // Independent heartbeat ticker keeps the docker healthcheck green as long
  // as the Node event loop is alive. False unhealthy flips during long
  // anti-flood pauses are gone, but on its own this does NOT detect a stuck
  // campaign loop (the May 10 incident proved that). The watchdog below
  // covers that gap.
  writeHeartbeat();
  const heartbeatTimer = setInterval(() => writeHeartbeat(), 30_000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  // Watchdog: if any running campaign hasn't reported progress for longer
  // than WATCHDOG_THRESHOLD_MS, the loop is almost certainly frozen
  // (gramJS recvLoop stuck, infinite proxy reconnect, etc). Force-exit so
  // docker restarts us and auto-resume rebuilds clients with fresh sockets.
  const watchdogTimer = setInterval(() => {
    if (shouldStop()) return;
    const now = Date.now();
    for (const [campaignId, lastAt] of campaignLastProgressAt) {
      const stallMs = now - lastAt;
      if (stallMs > WATCHDOG_THRESHOLD_MS) {
        log(
          'error',
          `Watchdog: campaign ${campaignId} no progress for ${Math.round(stallMs / 60_000)} min ` +
            `(threshold ${Math.round(WATCHDOG_THRESHOLD_MS / 60_000)} min). Exiting for restart.`,
        );
        process.exit(1);
      }
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

  const resumeTimer = setInterval(() => {
    if (shouldStop()) return;
    resumeRunningCampaigns().catch((err) =>
      log('error', `Periodic resume check failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    resumeWarmupRuns().catch((err) =>
      log('error', `Periodic warmup resume check failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, RESUME_CHECK_INTERVAL_MS);

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['tg_outreach_jobs'],
  });

  clearInterval(heartbeatTimer);
  clearInterval(watchdogTimer);
  clearInterval(resumeTimer);

  log('info', 'Waiting for running campaigns to finish...');
  const promises = Array.from(runningCampaigns.values()).map(r => {
    r.stop();
    return r.promise;
  });
  await Promise.all(promises);

  log('info', 'TG Outreach worker stopped');
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
