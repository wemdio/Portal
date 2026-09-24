/**
 * Стадия broad_hypotheses: добавить широкие гипотезы уровня сектора в уже
 * исследованный проект. Повторное исследование удаляет вертикали, а с ними
 * базы, шаблоны и цепочки, поэтому широкие дописываются отдельно: один вызов
 * модели research с тем же контекстом клиента и списком того, что
 * уже есть в проекте; каждая новая широкая — своя вертикаль, как при
 * кластеризации. Существующие гипотезы, вертикали, базы и выбор гипотез не
 * меняются. Проверки источниками нет: доказательств 0, обоснование и
 * потенциал — от генератора.
 */

import { z } from 'zod';

import { callLLMWithSchema, getVeModel } from '../llm';
import { VeBroadHypothesesOnlySchema } from '../schemas';
import { projectMarket } from '../market';
import { buildBroadHypothesesMessages } from '../prompts/broadHypotheses';
import { buildBroadHypothesesMessagesEn } from '../prompts/broadHypotheses.en';
import {
  VE_BROAD_HYPOTHESES_MAX,
  VE_BROAD_RESEARCH_BUSY_TEXT,
  countActiveBroadHypotheses,
  selectNewBroadCandidates,
} from '../broadHypotheses';
import type { VeJob } from '../types';
import { loadHypothesesClientContext } from './hypotheses';
import { addUsage, newUsage, readProject, stageLog, type VeStageContext, type VeStageResult } from './shared';

interface ExistingHypothesis {
  title: string;
  vertical_id: string | null;
  status: string;
  broad?: boolean | null;
}

interface ExistingVertical {
  id: string;
  name: string;
  synonyms: unknown;
  rank: number | null;
}

/** Итог задачи для интерфейса (ve_jobs.progress). Best-effort: сбой записи стадию не валит. */
async function reportOutcome(ctx: VeStageContext, jobId: string, added: number, label: string): Promise<void> {
  try {
    await ctx.supabase.from('ve_jobs').update({ progress: { done: added, total: added, label } }).eq('id', jobId);
  } catch {
    // прогресс — best-effort
  }
}

// The receipt is committed in the same transaction as both kinds of rows.
// It survives worker recovery, including a lost successful RPC response.
const BroadCommitSchema = z.object({
  broad_hypotheses_committed: z.literal(true),
  added: z.array(z.object({ title: z.string(), hypothesis_id: z.string().uuid(), vertical_id: z.string().uuid() })),
  duplicates: z.array(z.string()),
  requested: z.number().int().min(0).max(VE_BROAD_HYPOTHESES_MAX),
  tokensUsed: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

type BroadCommit = z.infer<typeof BroadCommitSchema>;

async function finishCommit(ctx: VeStageContext, job: VeJob, result: BroadCommit): Promise<VeStageResult> {
  await reportOutcome(ctx, job.id, result.added.length,
    result.added.length
      ? `Добавлено широких гипотез: ${result.added.length}`
      : result.duplicates.length
        ? 'Новых секторов не нашлось: предложенные уже есть в проекте'
        : 'Модель не предложила новых секторов для этого проекта');
  // The worker accounts usage after finalization; recovery must retain the
  // already paid call, while a replay of an accounted job adds no usage.
  return {
    result,
    tokensUsed: Math.max(0, result.tokensUsed - (job.tokens_used ?? 0)),
    costUsd: Math.max(0, result.costUsd - Number(job.cost_usd ?? 0)),
  };
}

export async function runBroadHypothesesStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const { data: saved, error: savedError } = await ctx.supabase.from('ve_jobs')
    .select('result').eq('id', job.id).eq('project_id', job.project_id).eq('stage', 'broad_hypotheses').single();
  if (savedError || !saved) throw new Error(`ve_jobs broad receipt: ${savedError?.message ?? 'job not found'}`);
  if (saved.result?.broad_hypotheses_committed === true) {
    return finishCommit(ctx, job, BroadCommitSchema.parse(saved.result));
  }
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const market = ctx.market ?? projectMarket(project);
  // Исследование перестраивает вертикали проекта — дописывать к ним нельзя.
  // Постановка такого не допускает; это страховка на случай гонки запросов.
  if (project.status === 'researching') {
    stageLog(ctx, '[broad_hypotheses] идёт исследование проекта — ничего не добавляем');
    await reportOutcome(ctx, job.id, 0, VE_BROAD_RESEARCH_BUSY_TEXT);
    return { result: { added: [], duplicates: [], requested: 0, reason: 'research' }, tokensUsed: 0, costUsd: 0 };
  }

  const [hypothesesRes, verticalsRes] = await Promise.all([
    ctx.supabase.from('ve_hypotheses').select('title, vertical_id, status, broad').eq('project_id', job.project_id),
    ctx.supabase.from('ve_verticals').select('id, name, synonyms, rank').eq('project_id', job.project_id),
  ]);
  if (hypothesesRes.error) throw new Error(`ve_hypotheses read: ${hypothesesRes.error.message}`);
  if (verticalsRes.error) throw new Error(`ve_verticals read: ${verticalsRes.error.message}`);
  const hypotheses = (hypothesesRes.data ?? []) as ExistingHypothesis[];
  const verticals = ((verticalsRes.data ?? []) as ExistingVertical[])
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  if (!verticals.length) {
    throw new Error('В проекте нет вертикалей: широкие гипотезы добавляются после исследования проекта');
  }

  const slots = VE_BROAD_HYPOTHESES_MAX - countActiveBroadHypotheses(hypotheses);
  if (slots <= 0) {
    stageLog(ctx, `[broad_hypotheses] в проекте уже ${VE_BROAD_HYPOTHESES_MAX} широких — модель не вызываем`);
    await reportOutcome(ctx, job.id, 0, `В проекте уже ${VE_BROAD_HYPOTHESES_MAX} широких гипотез — это предел`);
    return { result: { added: [], duplicates: [], requested: 0, reason: 'limit' }, tokensUsed: 0, costUsd: 0 };
  }

  const clientContext = await loadHypothesesClientContext(ctx, project, '[broad_hypotheses]');
  const existingBroad = hypotheses.filter((h) => h.broad === true).map((h) => h.title);
  const promptInput = {
    ...clientContext,
    count: slots,
    // Вертикаль из одних широких уже перечислена среди широких.
    verticals: verticals.flatMap((v) => {
      const own = hypotheses.filter((h) => h.vertical_id === v.id);
      const narrow = own.filter((h) => h.broad !== true).map((h) => h.title);
      return own.length > 0 && narrow.length === 0 ? [] : [{ name: v.name, hypotheses: narrow }];
    }),
    existingBroad,
  };
  stageLog(ctx, `[broad_hypotheses] просим до ${slots} широких; в проекте вертикалей: ${verticals.length}, гипотез: ${hypotheses.length}`);
  const llm = await callLLMWithSchema(
    (market === 'us' ? buildBroadHypothesesMessagesEn : buildBroadHypothesesMessages)(promptInput),
    VeBroadHypothesesOnlySchema,
    { model: getVeModel('research'), maxTokens: 8192, requireCompleteJson: true, signal: ctx.signal },
  );
  addUsage(usage, llm);

  const existingTitles = [
    ...hypotheses.map((h) => h.title),
    ...verticals.flatMap((v) => [
      v.name,
      ...(Array.isArray(v.synonyms) ? v.synonyms.filter((s): s is string => typeof s === 'string') : []),
    ]),
  ];
  const { added, duplicates } = selectNewBroadCandidates(llm.data.broad_hypotheses, existingTitles, slots);
  if (duplicates.length) stageLog(ctx, `[broad_hypotheses] повторы отброшены: ${duplicates.join('; ')}`);

  ctx.signal?.throwIfAborted();
  // Cancellation is checked by the transaction as well. Once it starts,
  // commit all sectors plus the receipt together; never compensate deletes.
  const { data, error } = await ctx.supabase.rpc('ve_commit_broad_hypotheses', {
    p_job_id: job.id,
    p_project_id: job.project_id,
    p_candidates: added,
    p_duplicates: duplicates,
    p_requested: slots,
    p_tokens_used: (job.tokens_used ?? 0) + usage.tokensUsed,
    p_cost_usd: Number(job.cost_usd ?? 0) + usage.costUsd,
  });
  if (error) throw new Error(`ve_commit_broad_hypotheses: ${error.message}`);
  const committed = BroadCommitSchema.parse(data);
  stageLog(ctx, `[broad_hypotheses] добавлено: ${committed.added.length} из ${llm.data.broad_hypotheses.length} предложенных`);
  return finishCommit(ctx, job, committed);
}
