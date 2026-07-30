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
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runHeStage } from '@/lib/hypothesisEngine/stages';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';

const WORKER_ID = `hypothesis-engine-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const MAX_ATTEMPTS = 3;

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
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('he_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      attempts: ((pending as HeJob).attempts ?? 0) + 1,
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

  const stageResult = await runHeStage(job, {
    supabase: db,
    log: (msg) => log('info', `[${job.stage}] ${msg}`),
  });
  const tokensUsed = stageResult.tokensUsed ?? 0;
  const costUsd = stageResult.costUsd ?? 0;

  // base_collect переводит свою строку обратно в pending (self-requeue на
  // время работы дочерних парсеров) и возвращает {waiting: true}. Не затираем
  // requeue финальным done-апдейтом — только накапливаем расход стадии.
  const { data: current } = await db
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (current && (current as { status: string }).status !== 'running') {
    await db
      .from('he_jobs')
      .update({
        tokens_used: (job.tokens_used ?? 0) + tokensUsed,
        cost_usd: Number(job.cost_usd ?? 0) + costUsd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
    log('info', `Job ${job.id} (${job.stage}) → waiting (self-requeue, +${tokensUsed} tok)`);
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
  const finalFail = job.attempts >= MAX_ATTEMPTS;
  log('error', `Job ${job.id} (${job.stage}) failed (attempt ${job.attempts}/${MAX_ATTEMPTS}): ${msg}`);

  await db
    .from('he_jobs')
    .update({
      status: finalFail ? 'failed' : 'pending',
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
  await resetStuckJobs();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['he_jobs'],
  });

  log('info', 'Hypothesis Engine worker stopped');
  process.exit(0);
}

void main();
