/**
 * Vertical Engine v2 worker — обрабатывает джобы из ve_jobs.
 *
 * Паттерн — копия salesAiAnalysis.ts: poll loop + realtime wake на INSERT/UPDATE
 * pending-джобы + graceful shutdown. На старте сбрасывает застрявшие 'running'
 * (после рестарта пода) обратно в 'pending' с сохранением attempts, иначе после
 * деплоя они висят навсегда.
 *
 * Здесь же живёт независимый guarded tick ежедневной VE2-дозагрузки контактов:
 * один проход на старте и затем раз в пять минут. Суточную идемпотентность и
 * точную резервацию строк обеспечивает main DB; process-local guard не даёт
 * одному экземпляру воркера запускать два прохода одновременно.
 *
 * Джобы создаются API (/api/tools/vertical-engine-v2/*): API ставит только
 * первую research-стадию (site_profile) либо точечные стадии (chain/vocab/
 * base_analyze/base_collect/template). Research-цепочку дальше ведёт сам воркер:
 * site_profile → competitors → brand_cloud → hypotheses → evidence → clustering.
 * Стадия base_collect — оркестратор: ждёт дочерние парсеры через self-requeue
 * (сама возвращает свою строку в pending; handleJob такой requeue не затирает
 * done-апдейтом). Стадии выполняются через runVeStage из lib/verticalEngineV2; fetchText/search
 * не переопределяем — используются дефолты либы (SSRF-гейт + websiteParser,
 * serperSearch).
 *
 * Отмена: cancel-роут (projects/[id]/cancel) переводит джобы проекта в
 * 'cancelled'. Pending не клеймятся; у running наблюдатель в handleJob
 * аборти́т LLM-запрос в контексте своей джобы, а если стадия успела
 * завершиться — done/дочейн не выполняются, attempts не растут (failJob).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, startWorkerHeartbeat } from './_shared';
import { markSegmentationAuditFailed, runVeStage } from '@/lib/verticalEngineV2/stages';
import { withVeActiveJobSignal } from '@/lib/verticalEngineV2/llm';
import { VeLlmRateLimitError } from '@/lib/verticalEngineV2/llmRateLimit';
import { withVeCostTelemetry } from '@/lib/verticalEngineV2/costTelemetry';
import { normalizeVeMarket } from '@/lib/verticalEngineV2/market';
import {
  isRetryableStageError,
  maxAttemptsFor,
  retryRunAfter,
} from '@/lib/verticalEngineV2/jobRetry';
import { transitionVeJobFailure } from '@/lib/verticalEngineV2/jobFailureTransition';
import { createVeJobShutdown, createVeJobWatchdog } from '@/lib/verticalEngineV2/workerLiveness';
import { claimVeJob, createVeJobPool, createVeProjectUsageAccumulator, veJobConcurrency } from '@/lib/verticalEngineV2/jobQueue';
import { VePreviewCheckpointConflict } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import {
  createGuardedContactDeliveryTick,
  runBoundContactDeliveries,
} from '@/lib/verticalEngineV2/contactDeliveryScheduler';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { runVeOutreachPreparations } from '@/lib/verticalEngineV2/outreachPreparation';
import type { VeJob, VeStage } from '@/lib/verticalEngineV2/types';

const WORKER_ID = `vertical-engine-v2-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
// One queue owner serializes research and per-base writes; independent bases
// share the bounded pool, including within the same project.
const JOB_CONCURRENCY = veJobConcurrency(process.env.VE_JOB_CONCURRENCY);
const OUTREACH_PREPARATION_INTERVAL_MS = 10_000;
const configuredContactDeliveryInterval = Number(process.env.VE_CONTACT_DELIVERY_INTERVAL_MS);
const CONTACT_DELIVERY_INTERVAL_MS =
  Number.isFinite(configuredContactDeliveryInterval) && configuredContactDeliveryInterval >= 60_000
    ? configuredContactDeliveryInterval
    : 5 * 60_000;
/** Как часто воркер проверяет строку активной джобы на отмену пользователем. */
const CANCEL_WATCH_MS = 3000;
const RESEARCH_IDLE_TIMEOUT_MS = 15 * 60_000;
const RESEARCH_ABORT_GRACE_MS = 30_000;
// Base stages had no inactivity guard: an await that never settled kept the
// row `running` while the process heartbeat stayed healthy (19.09.2026: four
// base_collect jobs silent for more than a day, each holding a project slot).
// Website reads and LLM calls are bounded well below this idle window.
const BASE_IDLE_TIMEOUT_MS = 20 * 60_000;
const BASE_ABORT_GRACE_MS = 2 * 60_000;
// Leave one minute for metering/final cleanup before Compose's five-minute stop.
const SHUTDOWN_CHECKPOINT_GRACE_MS = 4 * 60_000;

/**
 * Heartbeat-файл: обновляется каждые 30с независимым setInterval-тиком.
 * Docker healthcheck читает mtime и флипает контейнер в unhealthy, если он
 * не обновлялся > 300с — autoheal тогда перезапускает воркер (паттерн
 * worker/yandexmaps.ts, инцидент 27.07.2026: event-loop hang при живом
 * процессе невидим без внешнего heartbeat). Живой event loop при зависшем
 * research-await отдельно защищён inactivity watchdog ниже.
 */
const HEARTBEAT_PATH = process.env.VE_WORKER_HEARTBEAT_PATH ?? '/tmp/vertical-engine-v2-worker-heartbeat';

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

const contactDeliveryTick = createGuardedContactDeliveryTick({
  log: (level, message, extra) => log(level, `[contact-delivery] ${message}`, extra),
  run: async () => {
    const result = await runBoundContactDeliveries({
      portalDb: db,
      instantlyDb: supabaseInstantly,
      shouldStop,
      now: new Date(),
      log: (level, message, extra) => log(level, `[contact-delivery] ${message}`, extra),
    });
    if (!result.skipped && result.eligibleProjects > 0) {
      log(
        result.failedProjects > 0 ? 'warn' : 'info',
        `[contact-delivery] sweep done: ${result.attemptedProjects}/${result.eligibleProjects} attempted, ` +
          `${result.failedProjects} failed or uncertain`,
      );
    }
  },
});

let activeContactDeliveryTick: Promise<boolean> | null = null;
// Every stage can now end in a process exit (inactivity watchdog), not only research.
const activeJobAborts = new Set<AbortController>();

function triggerContactDeliveryTick(): Promise<boolean> {
  // Do not start a provider upload while an aborted job may still end in a
  // process exit. An already attempted upload keeps its durable
  // uncertain/recovery semantics.
  if (shouldStop() || [...activeJobAborts].some((abort) => abort.signal.aborted)) return Promise.resolve(false);
  const promise = contactDeliveryTick();
  if (!activeContactDeliveryTick) {
    activeContactDeliveryTick = promise;
    void promise.finally(() => {
      if (activeContactDeliveryTick === promise) activeContactDeliveryTick = null;
    });
  }
  return promise;
}

/** Порядок research-пайплайна: после done стадии ставится следующая (если её ещё нет). */
const NEXT_RESEARCH_STAGE: Partial<Record<VeStage, VeStage>> = {
  site_profile: 'competitors',
  competitors: 'brand_cloud',
  brand_cloud: 'hypotheses',
  hypotheses: 'evidence',
  evidence: 'clustering',
};

/** Стадии research-пайплайна — при финальном фейле помечают проект failed. */
const RESEARCH_STAGES = new Set<VeStage>([
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
]);

async function resetStuckJobs() {
  const { data, error } = await db
    .from('ve_jobs')
    .select('id')
    .eq('status', 'running');
  if (error) { log('error', `Stuck running jobs could not be read: ${error.message}`); return; }
  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to pending`);
    const { error: resetError } = await db
      .from('ve_jobs')
      .update({ status: 'pending', started_at: null, updated_at: new Date().toISOString() })
      .eq('status', 'running');
    // A silent failure here left orphaned rows running until the next restart.
    if (resetError) log('error', `Stuck running jobs were not reset: ${resetError.message}`);
  }
}

const accumulateUsage = createVeProjectUsageAccumulator(db);
/** The durable provider journal remains authoritative if this UI aggregate fails. */
async function accumulateProjectUsage(projectId: string, tokensUsed: number, costUsd: number) {
  try { await accumulateUsage(projectId, tokensUsed, costUsd); }
  catch (error) { log('warn', `Project usage aggregate was not updated for ${projectId}`, error); }
}

/**
 * Дочейнить следующую research-стадию. Идемпотентно: если такая стадия уже
 * стоит в pending/running по этому проекту (повторный прогон, гонка с API) —
 * дубликат не ставим.
 */
async function enqueueNextResearchStage(job: VeJob) {
  const nextStage = NEXT_RESEARCH_STAGE[job.stage];
  if (!nextStage) return;

  const { data: existing } = await db
    .from('ve_jobs')
    .select('id')
    .eq('project_id', job.project_id)
    .eq('stage', nextStage)
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle();
  if (existing) return;

  const { error } = await db
    .from('ve_jobs')
    .insert({ project_id: job.project_id, stage: nextStage });
  if (error) throw new Error(`enqueue ${nextStage}: ${error.message}`);
  log('info', `Job ${job.id} (${job.stage}) → enqueued ${nextStage} for project ${job.project_id}`);
}

async function handleJob(job: VeJob) {
  log('info', `Running stage ${job.stage} for project ${job.project_id} (job ${job.id}, attempt ${job.attempts})`);

  // Отмена задачи: cancel-роут переводит джобу в 'cancelled'. Наблюдатель
  // раз в CANCEL_WATCH_MS перечитывает строку и аборти́т контроллер — сигнал
  // проброшен в LLM-слой через контекст джобы, текущий запрос к модели
  // обрывается сразу, а не по окончании стадии. Если стадия сейчас не в
  // LLM-вызове, отмена сработает по завершении: статус 'cancelled' ниже не
  // даёт записать done и дочейнить следующую стадию.
  const abort = new AbortController();
  const isResearch = RESEARCH_STAGES.has(job.stage);
  let lastActivity = `stage ${job.stage} started`;
  const idleMs = isResearch ? RESEARCH_IDLE_TIMEOUT_MS : BASE_IDLE_TIMEOUT_MS;
  const graceMs = isResearch ? RESEARCH_ABORT_GRACE_MS : BASE_ABORT_GRACE_MS;
  // The abort message contains "timeout", so failJob treats it as transient:
  // the job returns to pending with backoff and its checkpoint, not to failed.
  // An await that ignores the abort leaves a zombie that could later write
  // stale state; the process exits so the container restart recovers the queue.
  const watchdog = createVeJobWatchdog({
    abort,
    idleMs,
    graceMs,
    reason: `VE2 ${job.stage} inactivity timeout`,
    // A cancel of one base must not recycle a process that runs 16 jobs.
    escalateExternalAbort: isResearch,
    onTimeout: () => log('error', `Inactivity timeout: job ${job.id} (${job.stage}) after ${idleMs}ms; last activity: ${lastActivity}`),
    onUnresponsive: (waitedMs) => {
      log('error', `Job ${job.id} (${job.stage}) ignored abort for ${waitedMs}ms; exiting without starting another job`);
      process.exit(1);
    },
  });
  const shutdown = createVeJobShutdown({
    abort, immediate: isResearch, graceMs: SHUTDOWN_CHECKPOINT_GRACE_MS,
    onDeadline: () => log('warn', `Job ${job.id} did not reach a shutdown checkpoint; aborting for restart`),
  });
  const onShutdown = () => shutdown.request();
  activeJobAborts.add(abort);
  process.once('SIGTERM', onShutdown);
  process.once('SIGINT', onShutdown);
  if (shouldStop()) shutdown.request();
  let cancelCheckInFlight = false;
  let watching = true;
  const cancelWatcher = setInterval(() => {
    if (!watching || cancelCheckInFlight || abort.signal.aborted) return;
    cancelCheckInFlight = true;
    void (async () => {
      try {
        const { data } = await db
          .from('ve_jobs')
          .select('status')
          .eq('id', job.id)
          .maybeSingle();
        if (watching && data && (data as { status: string }).status === 'cancelled') abort.abort();
      } catch {
        // Транзиентная ошибка БД не должна ронять воркер — следующий тик повторит.
      } finally {
        cancelCheckInFlight = false;
      }
    })();
  }, CANCEL_WATCH_MS);

  let stageResult;
  try {
    shutdown.checkpoint();
    // Рынок проекта (geo поиска, язык промптов/писем) — один read на джобу.
    const { data: proj } = await db
      .from('ve_projects')
      .select('market')
      .eq('id', job.project_id)
      .maybeSingle();
    const market = normalizeVeMarket((proj as { market?: string } | null)?.market);
    if (isResearch) abort.signal.throwIfAborted();

    stageResult = await withVeActiveJobSignal(abort.signal, () => withVeCostTelemetry(db, job, () => runVeStage(job, {
      supabase: db,
      market,
      signal: abort.signal,
      onCheckpoint: () => { watchdog.touch(); shutdown.checkpoint(); },
      onActivity: () => watchdog.touch(),
      log: (msg) => {
        lastActivity = msg.slice(0, 500);
        watchdog.touch();
        log('info', `[${job.stage}] ${msg}`);
      },
    }), () => watchdog.touch()));
    if (isResearch) abort.signal.throwIfAborted();
  } finally {
    // Deliberately guard execution, not the legacy non-atomic done→enqueue
    // finalization. Never kill between those writes as a recovery strategy.
    watching = false;
    clearInterval(cancelWatcher);
    watchdog.stop();
    shutdown.stop();
    process.removeListener('SIGTERM', onShutdown);
    process.removeListener('SIGINT', onShutdown);
    activeJobAborts.delete(abort);
  }
  const tokensUsed = stageResult.tokensUsed ?? 0;
  const costUsd = stageResult.costUsd ?? 0;

  // base_collect и evidence переводят свою строку обратно в pending (ожидание
  // парсеров / уступка очереди после checkpoint). Не затираем
  // requeue финальным done-апдейтом — только накапливаем расход стадии.
  // Сюда же попадает 'cancelled': стадия завершилась после отмены — done и
  // дочейн следующей research-стадии не выполняем, джоба остаётся cancelled.
  const { data: current } = await db
    .from('ve_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (current && (current as { status: string }).status !== 'running') {
    const cancelled = (current as { status: string }).status === 'cancelled';
    // Evidence keeps cumulative usage in its durable checkpoint until the
    // entire stage finishes. A yield must not account it, finalize the job or
    // enqueue clustering; even a zero-usage bookkeeping write is unnecessary.
    if (job.stage === 'evidence' && (current as { status: string }).status === 'pending') {
      log('info', `Job ${job.id} (evidence) → yielded with saved checkpoint`);
      return;
    }
    await db
      .from('ve_jobs')
      .update({
        tokens_used: (job.tokens_used ?? 0) + tokensUsed,
        cost_usd: Number(job.cost_usd ?? 0) + costUsd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
    log(
      'info',
      cancelled
        ? `Job ${job.id} (${job.stage}) → cancelled пользователем (+${tokensUsed} tok до отмены)`
        : `Job ${job.id} (${job.stage}) → waiting (self-requeue, +${tokensUsed} tok)`,
    );
    return;
  }

  const { data: completed, error: completeError } = await db
    .from('ve_jobs')
    .update({
      status: 'done',
      result: (stageResult.result ?? {}) as Record<string, unknown>,
      error: null,
      finished_at: new Date().toISOString(),
      tokens_used: (job.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(job.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (completeError) throw new Error(`ve_jobs complete: ${completeError.message}`);
  if (!completed) {
    await db
      .from('ve_jobs')
      .update({
        tokens_used: (job.tokens_used ?? 0) + tokensUsed,
        cost_usd: Number(job.cost_usd ?? 0) + costUsd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'cancelled');
    await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
    log('info', `Job ${job.id} (${job.stage}) was cancelled before completion (+${tokensUsed} tok)`);
    return;
  }

  await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
  await enqueueNextResearchStage(job);
  if (job.stage === 'base_analyze' || job.stage === 'template') void triggerOutreachPreparationTick();
  log('info', `Job ${job.id} (${job.stage}) → done (+${tokensUsed} tok, $${costUsd.toFixed(6)})`);
}

async function failJob(job: VeJob, err: unknown) {
  if (err instanceof VePreviewCheckpointConflict) {
    // Another invocation advanced the durable base. Its continuation (or the
    // existing stale-job recovery after a crash) owns the next transition.
    log('info', `Job ${job.id} (${job.stage}) stopped after a preview checkpoint conflict`);
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Отменённая пользователем джоба: стадия упала по AbortSignal. Это не фейл —
  // не инкрементируем attempts, не затираем 'cancelled', не валим проект/базу.
  const { data: currentBefore } = await db
    .from('ve_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (currentBefore && (currentBefore as { status: string }).status === 'cancelled') {
    log('info', `Job ${job.id} (${job.stage}) aborted by user cancel`);
    return;
  }
  // attempts — число фейлов, а не клеймов: инкремент только здесь.
  const retryable = isRetryableStageError(msg);
  const attemptCap = maxAttemptsFor(msg);
  const rateLimit = err instanceof VeLlmRateLimitError ? err : undefined;
  const nextAttempts = job.attempts + Number(!rateLimit?.deferred);
  const finalFail = nextAttempts >= attemptCap;
  log('error', `Job ${job.id} (${job.stage}) failed (attempt ${nextAttempts}/${attemptCap}${retryable ? ', retryable' : ''}): ${msg}`);

  // Release the active-audit slot before the generic job transition. If the
  // process dies between these writes, a recovered old job sees terminal
  // audit state and cannot repeat the LLM classification.
  if (finalFail && job.stage === 'segmentation_audit') {
    await markSegmentationAuditFailed(db, job, err);
  }

  const transition = await transitionVeJobFailure(db, {
    jobId: job.id,
    status: finalFail ? 'failed' : 'pending',
    attempts: nextAttempts,
    error: msg.slice(0, 500),
    finishedAt: finalFail ? new Date().toISOString() : null,
    // Транзиентные ошибки пережидаем с бэкоффом (run_after в будущем), чтобы
    // провайдер успел восстановиться; постоянные клеймим сразу, как раньше.
    runAfter: retryRunAfter(nextAttempts, retryable, Date.now(), rateLimit, job.id),
    updatedAt: new Date().toISOString(),
  });
  if (transition.error) throw new Error(`ve_jobs fail transition: ${transition.error}`);
  if (!transition.transitioned) {
    log('info', `Job ${job.id} (${job.stage}) cancellation won the failure transition`);
    return;
  }

  // Финальный фейл research-стадии валит весь research-пайплайн проекта.
  if (finalFail && RESEARCH_STAGES.has(job.stage)) {
    await db
      .from('ve_projects')
      .update({
        status: 'failed',
        error: `${job.stage}: ${msg}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id);
  }

  // Финальный фейл base_collect: без этого ve_bases навсегда остаётся в
  // 'collecting', и collect-роут продолжает отдавать базу как живую. payload
  // может не содержать base_id — тогда просто не трогаем базу.
  // Только status='collecting': стадия сама валит базу с ПРИЧИНОЙ («ноль
  // строк», отказ пробы среза), а ретраи после этого умирают в start-guard —
  // без фильтра его текст «сборка уже завершена» перетирал осмысленную причину
  // (так выглядели базы Franchise Brands 12.08).
  if (finalFail && job.stage === 'base_collect') {
    const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
    if (baseId) {
      await db
        .from('ve_bases')
        .update({
          status: 'failed',
          error: msg.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', baseId)
        .eq('status', 'collecting');
    }
  }

}

let activeOutreachPreparationTick: Promise<void> | null = null;
function triggerOutreachPreparationTick(): Promise<void> {
  if (shouldStop() || activeOutreachPreparationTick) return activeOutreachPreparationTick ?? Promise.resolve();
  activeOutreachPreparationTick = (async () => {
    try { await runVeOutreachPreparations(db, shouldStop); }
    catch (error) { log('warn', `[outreach] preparation tick: ${error instanceof Error ? error.message : 'unavailable'}`); }
    finally { activeOutreachPreparationTick = null; }
  })();
  return activeOutreachPreparationTick;
}

async function processClaimedJob(job: VeJob): Promise<void> {
  try {
    await handleJob(job);
  } catch (err) {
    if (shouldStop()) {
      // Leave running + its checkpoint for startup recovery; a deployment
      // interruption is not a failed provider attempt and must not use retries.
      log('info', `Job ${job.id} (${job.stage}) interrupted by shutdown; preserving checkpoint for restart`);
    } else {
      await failJob(job, err);
    }
  }
}

const jobPool = createVeJobPool({
  concurrency: JOB_CONCURRENCY, idleMs: POLL_INTERVAL_MS, shouldStop,
  claim: (activeJobs) => claimVeJob(db, new Date(), activeJobs),
  run: processClaimedJob,
  onError: (error) => log('error', 'Job finalization failed; preserving state for recovery', error),
});

async function main() {
  // Each active job installs and removes its own two shutdown listeners.
  if (process.getMaxListeners() > 0) process.setMaxListeners(Math.max(process.getMaxListeners(), JOB_CONCURRENCY + 8));
  log('info', `Vertical Engine v2 worker starting (${JOB_CONCURRENCY} concurrent jobs; at most 4 independent bases per project)…`);

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  await resetStuckJobs();

  const contactDeliveryTimer = setInterval(
    () => { void triggerContactDeliveryTick(); },
    CONTACT_DELIVERY_INTERVAL_MS,
  );
  if (typeof contactDeliveryTimer.unref === 'function') contactDeliveryTimer.unref();
  const outreachPreparationTimer = setInterval(
    () => { void triggerOutreachPreparationTick(); },
    OUTREACH_PREPARATION_INTERVAL_MS,
  );
  if (typeof outreachPreparationTimer.unref === 'function') outreachPreparationTimer.unref();

  try {
    // Delivery is independent from VE research/template jobs; do not hold the
    // main poll loop behind a potentially slow provider batch at process start.
    void triggerContactDeliveryTick();
    // Preparation only coordinates durable jobs. Keep it advancing while a
    // collection or model call occupies the main worker for several minutes.
    void triggerOutreachPreparationTick();
    await pollLoop({
      log,
      pollIntervalMs: POLL_INTERVAL_MS,
      shouldStop,
      pollOnce: jobPool.pollOnce,
      realtimeTables: ['ve_jobs'],
    });
  } finally {
    clearInterval(contactDeliveryTimer);
    clearInterval(outreachPreparationTimer);
    await jobPool.drain();
    if (activeContactDeliveryTick) await activeContactDeliveryTick;
    if (activeOutreachPreparationTick) await activeOutreachPreparationTick;
    clearInterval(heartbeat);
  }

  log('info', 'Hypothesis Engine worker stopped');
  process.exit(0);
}

void main();
