/**
 * Стадия broad_hypotheses: добавить широкие гипотезы уровня сектора в уже
 * исследованный проект. Повторное исследование удаляет вертикали, а с ними
 * базы, шаблоны и цепочки, поэтому широкие дописываются отдельно: один вызов
 * модели стадии hypotheses с тем же контекстом клиента и списком того, что
 * уже есть в проекте; каждая новая широкая — своя вертикаль, как при
 * кластеризации. Существующие гипотезы, вертикали, базы и выбор гипотез не
 * меняются. Проверки источниками нет: доказательств 0, обоснование и
 * потенциал — от генератора.
 */

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
import type { VeHypothesisCandidate } from '../schemas';
import type { VeJob } from '../types';
import { computeVerticalPct } from './clustering';
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

/**
 * Записать новые широкие: вертикали пачкой, затем гипотезы пачкой. Всё или
 * ничего — повтор задачи ничего не стирает, поэтому осколок записи при
 * упавшей задаче остался бы навсегда. Отмена после ответа модели запись уже
 * не прерывает: секторы появятся все.
 */
async function writeBroadHypotheses(
  ctx: VeStageContext,
  projectId: string,
  added: readonly VeHypothesisCandidate[],
  verticals: readonly ExistingVertical[],
): Promise<Array<{ title: string; hypothesis_id: string; vertical_id: string }>> {
  ctx.signal?.throwIfAborted();
  // Новые вертикали — после существующих: их порядок и ранги не меняются.
  const lastRank = verticals.reduce((max, v) => Math.max(max, typeof v.rank === 'number' ? v.rank : 0), verticals.length);
  const { data: verticalRows, error: verticalError } = await ctx.supabase
    .from('ve_verticals')
    .insert(added.map((candidate, i) => ({
      project_id: projectId,
      name: candidate.title,
      summary: candidate.description,
      synonyms: [candidate.title],
      potential_pct: computeVerticalPct([candidate.potential_pct]),
      rank: lastRank + i + 1,
    })))
    .select('id, name');
  // Названия в пачке различны (повторы отсеяны), по ним и сопоставляем.
  const verticalIds = new Map(((verticalRows ?? []) as Array<{ id: string; name: string }>).map((v) => [v.name, v.id]));
  // Вертикаль без гипотезы показалась бы пустой группой: убираем созданные этой задачей.
  const removeVerticals = async () => {
    if (!verticalIds.size) return;
    const { error } = await ctx.supabase.from('ve_verticals').delete().eq('project_id', projectId).in('id', [...verticalIds.values()]);
    if (error) stageLog(ctx, `[broad_hypotheses] не удалось убрать пустые вертикали: ${error.message}`);
  };
  if (verticalError || added.some((candidate) => !verticalIds.has(candidate.title))) {
    await removeVerticals();
    throw new Error(`ve_verticals insert: ${verticalError?.message ?? 'не вернулись созданные вертикали'}`);
  }

  const { data: hypothesisRows, error: hypothesisError } = await ctx.supabase
    .from('ve_hypotheses')
    .insert(added.map((candidate) => ({
      project_id: projectId,
      vertical_id: verticalIds.get(candidate.title),
      tier: 1,
      title: candidate.title,
      description: candidate.description,
      fit_rationale: candidate.fit_rationale,
      evidence: [],
      seasonality: null,
      potential_pct: candidate.potential_pct,
      status: 'proposed',
      broad: true,
    })))
    .select('id, title');
  if (hypothesisError) {
    await removeVerticals();
    throw new Error(`ve_hypotheses insert: ${hypothesisError.message}`);
  }
  const hypothesisIds = new Map(((hypothesisRows ?? []) as Array<{ id: string; title: string }>).map((h) => [h.title, h.id]));
  return added.map((candidate) => ({
    title: candidate.title,
    hypothesis_id: hypothesisIds.get(candidate.title) ?? '',
    vertical_id: verticalIds.get(candidate.title) as string,
  }));
}

export async function runBroadHypothesesStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
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
    { model: getVeModel('research'), maxTokens: 8192, signal: ctx.signal },
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

  const written = added.length ? await writeBroadHypotheses(ctx, job.project_id, added, verticals) : [];

  stageLog(ctx, `[broad_hypotheses] добавлено: ${written.length} из ${llm.data.broad_hypotheses.length} предложенных`);
  await reportOutcome(
    ctx,
    job.id,
    written.length,
    written.length
      ? `Добавлено широких гипотез: ${written.length}`
      : duplicates.length
        ? 'Новых секторов не нашлось: предложенные уже есть в проекте'
        : 'Модель не предложила новых секторов для этого проекта',
  );
  return {
    result: { added: written, duplicates, requested: slots },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
