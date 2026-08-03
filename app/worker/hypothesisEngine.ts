/**
 * Hypothesis Engine worker — обрабатывает джобы из he_jobs («Движок вертикалей»).
 *
 * Паттерн — копия salesAiAnalysis.ts: poll loop + realtime wake на INSERT/UPDATE
 * pending-джобы + graceful shutdown. На старте сбрасывает застрявшие 'running'
 * (после рестарта пода) обратно в 'pending' с сохранением attempts, иначе после
 * деплоя они висят навсегда.
 *
 * Джобы создаются API (/api/tools/hypothesis-engine/*): API ставит только
 * первую research-стадию (site_profile) либо точечные стадии (chain/vocab/
 * base_analyze/base_collect/template). Research-цепочку дальше ведёт сам воркер:
 * site_profile → competitors → brand_cloud → hypotheses → evidence → clustering.
 * Стадия base_collect — оркестратор: ждёт дочерние парсеры через self-requeue
 * (сама возвращает свою строку в pending; handleJob такой requeue не затирает
 * done-апдейтом). Стадии выполняются через runHeStage из lib/hypothesisEngine; fetchText/search
 * не переопределяем — используются дефолты либы (SSRF-гейт + websiteParser,
 * serperSearch).
 *
 * Отмена: cancel-роут (projects/[id]/cancel) переводит джобы проекта в
 * 'cancelled'. Pending не клеймятся; у running наблюдатель в handleJob
 * аборти́т LLM-запрос через setHeActiveJobSignal, а если стадия успела
 * завершиться — done/дочейн не выполняются, attempts не растут (failJob).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, startWorkerHeartbeat } from './_shared';
import { runHeStage } from '@/lib/hypothesisEngine/stages';
import { setHeActiveJobSignal } from '@/lib/hypothesisEngine/llm';
import { normalizeHeMarket } from '@/lib/hypothesisEngine/market';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';

const WORKER_ID = `hypothesis-engine-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const MAX_ATTEMPTS = 3;
/** Как часто воркер проверяет строку активной джобы на отмену пользователем. */
const CANCEL_WATCH_MS = 3000;

/**
 * Heartbeat-файл: обновляется каждые 30с независимым setInterval-тиком.
 * Docker healthcheck читает mtime и флипает контейнер в unhealthy, если он
 * не обновлялся > 300с — autoheal тогда перезапускает воркер (паттерн
 * worker/yandexmaps.ts, инцидент 27.07.2026: event-loop hang при живом
 * процессе невидим без внешнего heartbeat).
 */
const HEARTBEAT_PATH = process.env.HE_WORKER_HEARTBEAT_PATH ?? '/tmp/hypothesis-engine-worker-heartbeat';

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

/** Порядок research-пайплайна: после done стадии ставится следующая (если её ещё нет). */
const NEXT_RESEARCH_STAGE: Partial<Record<HeStage, HeStage>> = {
  site_profile: 'competitors',
  competitors: 'brand_cloud',
  brand_cloud: 'hypotheses',
  hypotheses: 'evidence',
  evidence: 'clustering',
};

/** Стадии research-пайплайна — при финальном фейле помечают проект failed. */
const RESEARCH_STAGES = new Set<HeStage>([
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
]);

async function resetStuckJobs() {
  const { data } = await db
    .from('he_jobs')
    .select('id')
    .eq('status', 'running');
  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to pending`);
    await db
      .from('he_jobs')
      .update({ status: 'pending', started_at: null, updated_at: new Date().toISOString() })
      .eq('status', 'running');
  }
}

async function claimJob(): Promise<HeJob | null> {
  const { data: pending } = await db
    .from('he_jobs')
    .select('*')
    .eq('status', 'pending')
    // Отложенные джобы (self-requeue base_collect ставит run_after в будущее)
    // не клеймим раньше времени — иначе ожидание дочерних парсеров
    // превращается в hot spin по БД.
    .lte('run_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  // attempts здесь НЕ инкрементируем: attempts — счётчик фейлов (failJob),
  // а не клеймов. Self-requeue base_collect переводит джобу в pending десятки
  // раз подряд — инкремент на клейме сжигал все попытки за секунды ожидания.
  const { data: claimed } = await db
    .from('he_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', (pending as HeJob).id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return (claimed as HeJob | null) ?? null;
}

/** Добавить расход стадии на проект (read-modify-write, воркер один на проект). */
async function accumulateProjectUsage(projectId: string, tokensUsed: number, costUsd: number) {
  if (!tokensUsed && !costUsd) return;
  const { data: project } = await db
    .from('he_projects')
    .select('tokens_used, cost_usd')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return;
  const p = project as { tokens_used: number | null; cost_usd: number | string | null };
  await db
    .from('he_projects')
    .update({
      tokens_used: (p.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(p.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);
}

/**
 * Дочейнить следующую research-стадию. Идемпотентно: если такая стадия уже
 * стоит в pending/running по этому проекту (повторный прогон, гонка с API) —
 * дубликат не ставим.
 */
async function enqueueNextResearchStage(job: HeJob) {
  const nextStage = NEXT_RESEARCH_STAGE[job.stage];
  if (!nextStage) return;

  const { data: existing } = await db
    .from('he_jobs')
    .select('id')
    .eq('project_id', job.project_id)
    .eq('stage', nextStage)
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle();
  if (existing) return;

  const { error } = await db
    .from('he_jobs')
    .insert({ project_id: job.project_id, stage: nextStage });
  if (error) throw new Error(`enqueue ${nextStage}: ${error.message}`);
  log('info', `Job ${job.id} (${job.stage}) → enqueued ${nextStage} for project ${job.project_id}`);
}

async function handleJob(job: HeJob) {
  log('info', `Running stage ${job.stage} for project ${job.project_id} (job ${job.id}, attempt ${job.attempts})`);

  // Отмена задачи: cancel-роут переводит джобу в 'cancelled'. Наблюдатель
  // раз в CANCEL_WATCH_MS перечитывает строку и аборти́т контроллер — сигнал
  // проброшен в LLM-слой (setHeActiveJobSignal), текущий запрос к модели
  // обрывается сразу, а не по окончании стадии. Если стадия сейчас не в
  // LLM-вызове, отмена сработает по завершении: статус 'cancelled' ниже не
  // даёт записать done и дочейнить следующую стадию.
  const abort = new AbortController();
  setHeActiveJobSignal(abort.signal);
  const cancelWatcher = setInterval(() => {
    void (async () => {
      try {
        const { data } = await db
          .from('he_jobs')
          .select('status')
          .eq('id', job.id)
          .maybeSingle();
        if (data && (data as { status: string }).status === 'cancelled') abort.abort();
      } catch {
        // Транзиентная ошибка БД не должна ронять воркер — следующий тик повторит.
      }
    })();
  }, CANCEL_WATCH_MS);

  let stageResult;
  try {
    // Рынок проекта (geo поиска, язык промптов/писем) — один read на джобу.
    const { data: proj } = await db
      .from('he_projects')
      .select('market')
      .eq('id', job.project_id)
      .maybeSingle();
    const market = normalizeHeMarket((proj as { market?: string } | null)?.market);

    stageResult = await runHeStage(job, {
      supabase: db,
      market,
      log: (msg) => log('info', `[${job.stage}] ${msg}`),
    });
  } finally {
    clearInterval(cancelWatcher);
    setHeActiveJobSignal(null);
  }
  const tokensUsed = stageResult.tokensUsed ?? 0;
  const costUsd = stageResult.costUsd ?? 0;

  // base_collect переводит свою строку обратно в pending (self-requeue на
  // время работы дочерних парсеров) и возвращает {waiting: true}. Не затираем
  // requeue финальным done-апдейтом — только накапливаем расход стадии.
  // Сюда же попадает 'cancelled': стадия завершилась после отмены — done и
  // дочейн следующей research-стадии не выполняем, джоба остаётся cancelled.
  const { data: current } = await db
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (current && (current as { status: string }).status !== 'running') {
    const cancelled = (current as { status: string }).status === 'cancelled';
    await db
      .from('he_jobs')
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

  await db
    .from('he_jobs')
    .update({
      status: 'done',
      result: (stageResult.result ?? {}) as Record<string, unknown>,
      error: null,
      finished_at: new Date().toISOString(),
      tokens_used: (job.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(job.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
  await enqueueNextResearchStage(job);
  log('info', `Job ${job.id} (${job.stage}) → done (+${tokensUsed} tok, $${costUsd.toFixed(6)})`);
}

async function failJob(job: HeJob, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // Отменённая пользователем джоба: стадия упала по AbortSignal. Это не фейл —
  // не инкрементируем attempts, не затираем 'cancelled', не валим проект/базу.
  const { data: currentBefore } = await db
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (currentBefore && (currentBefore as { status: string }).status === 'cancelled') {
    log('info', `Job ${job.id} (${job.stage}) aborted by user cancel`);
    return;
  }
  // attempts — число фейлов, а не клеймов: инкремент только здесь.
  const nextAttempts = job.attempts + 1;
  const finalFail = nextAttempts >= MAX_ATTEMPTS;
  log('error', `Job ${job.id} (${job.stage}) failed (attempt ${nextAttempts}/${MAX_ATTEMPTS}): ${msg}`);

  await db
    .from('he_jobs')
    .update({
      status: finalFail ? 'failed' : 'pending',
      attempts: nextAttempts,
      error: msg.slice(0, 500),
      finished_at: finalFail ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Финальный фейл research-стадии валит весь research-пайплайн проекта.
  if (finalFail && RESEARCH_STAGES.has(job.stage)) {
    await db
      .from('he_projects')
      .update({
        status: 'failed',
        error: `${job.stage}: ${msg}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id);
  }

  // Финальный фейл base_collect: без этого he_bases навсегда остаётся в
  // 'collecting' (failed пишет только путь «ноль строк» в самой стадии), и
  // collect-роут продолжает отдавать базу как живую. payload может не
  // содержать base_id — тогда просто не трогаем базу.
  if (finalFail && job.stage === 'base_collect') {
    const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
    if (baseId) {
      await db
        .from('he_bases')
        .update({
          status: 'failed',
          error: msg.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', baseId);
    }
  }
}

async function pollOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  try {
    await handleJob(job);
  } catch (err) {
    await failJob(job, err);
  }
  return true;
}

async function main() {
  log('info', 'Hypothesis Engine worker starting…');

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  await resetStuckJobs();

  try {
    await pollLoop({
      log,
      pollIntervalMs: POLL_INTERVAL_MS,
      shouldStop,
      pollOnce,
      realtimeTables: ['he_jobs'],
    });
  } finally {
    clearInterval(heartbeat);
  }

  log('info', 'Hypothesis Engine worker stopped');
  process.exit(0);
}

void main();
