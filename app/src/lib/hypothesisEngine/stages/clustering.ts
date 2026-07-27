/**
 * Стадия clustering: LLM выносит решения о слиянии гипотез в вертикали,
 * pure-функция applyClusteringDecisions детерминированно применяет их
 * (матчинг по точному title, агрегация %, ранжирование), результат пишется
 * в he_verticals + he_hypotheses.vertical_id. Проект → status 'researched'.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeClusteringSchema, type HeClusteringDecision } from '../schemas';
import { buildClusteringMessages } from '../prompts/clustering';
import type { HeHypothesis, HeJob } from '../types';
import {
  addUsage,
  newUsage,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/* ───────────────── Pure-часть: применение решений ───────────────── */

export interface ClusterHypothesisInput {
  title: string;
  potential_pct: number;
  description?: string;
  /** Тир гипотезы (1–3) — используется только в тай-брейке ранжирования. */
  tier?: number;
}

export interface AppliedVertical {
  name: string;
  summary: string;
  synonyms: string[];
  memberTitles: string[];
  potential_pct: number;
  rank: number;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Детерминированный % вертикали по % её участников:
 * max участников + 2 п.п. за каждого дополнительного, кап 95 —
 * плато и вырожденное ранжирование исключены. Нефинитные значения = 0.
 * Используется и при кластеризации, и при пересчёте после ручной
 * разметки гипотез (см. reviewRecompute.ts).
 */
export function computeVerticalPct(memberPcts: number[]): number {
  const maxPct = memberPcts.reduce(
    (acc, p) => Math.max(acc, Number.isFinite(p) ? p : 0),
    0,
  );
  return Math.min(95, maxPct + 2 * (memberPcts.length - 1));
}

function uniquePush(list: string[], values: string[]): string[] {
  const seen = new Set(list.map(normKey));
  const out = [...list];
  for (const v of values) {
    const k = normKey(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Применяет решения LLM о слиянии к списку гипотез:
 *  - member_titles матчатся по точному title (регистронезависимо, без
 *    лишних пробелов); каждая гипотеза попадает максимум в одну вертикаль
 *    (выигрывает первая решившая её вертикаль);
 *  - решения с одинаковым именем вертикали сливаются в одну;
 *  - решения без единого совпавшего member_title отбрасываются;
 *  - нераспределённые гипотезы становятся вертикалями-одиночками;
 *  - potential_pct вертикали считается детерминированно в коде (LLM его не
 *    задаёт): min(95, max(% участников) + 2 × (число участников − 1)) —
 *    max плюс небольшой бонус за ширину; кап 95 делает плато невозможным;
 *  - rank — по убыванию potential_pct (1 = лучшая); тай-брейки: больше
 *    участников → наличие более низкого тира → имя.
 *  Отклонённые гипотезы сюда не попадают: стадия evidence пишет в
 *  he_hypotheses только принятые, поэтому функция работает со всем входом.
 */
export function applyClusteringDecisions(
  hypotheses: ClusterHypothesisInput[],
  decisions: HeClusteringDecision[],
): AppliedVertical[] {
  const byNorm = new Map<string, ClusterHypothesisInput>();
  for (const h of hypotheses) {
    const k = normKey(h.title);
    if (k && !byNorm.has(k)) byNorm.set(k, h);
  }

  interface MutableGroup extends AppliedVertical {
    members: ClusterHypothesisInput[];
  }
  const groups: MutableGroup[] = [];
  const assigned = new Set<string>();

  for (const d of decisions) {
    const members: ClusterHypothesisInput[] = [];
    for (const title of d.member_titles) {
      const k = normKey(title);
      const h = byNorm.get(k);
      if (!h || assigned.has(k)) continue;
      assigned.add(k);
      members.push(h);
    }
    if (!members.length) continue;

    const existing = groups.find((g) => normKey(g.name) === normKey(d.name));
    if (existing) {
      existing.members.push(...members);
      existing.memberTitles = uniquePush(existing.memberTitles, members.map((m) => m.title));
      existing.synonyms = uniquePush(existing.synonyms, d.synonyms);
      if (!existing.summary && d.summary) existing.summary = d.summary;
    } else {
      groups.push({
        name: d.name,
        summary: d.summary,
        synonyms: uniquePush([], d.synonyms),
        memberTitles: uniquePush([], members.map((m) => m.title)),
        members,
        potential_pct: 0,
        rank: 0,
      });
    }
  }

  // Нераспределённые гипотезы → вертикали-одиночки (ничего не теряем).
  for (const h of hypotheses) {
    const k = normKey(h.title);
    if (!k || assigned.has(k)) continue;
    assigned.add(k);
    groups.push({
      name: h.title,
      summary: h.description ?? '',
      synonyms: [h.title],
      memberTitles: [h.title],
      members: [h],
      potential_pct: 0,
      rank: 0,
    });
  }

  // Детерминированный %: max участников + 2 п.п. за каждого дополнительного,
  // кап 95 — плато и вырожденное ранжирование исключены.
  for (const g of groups) {
    g.potential_pct = computeVerticalPct(g.members.map((m) => m.potential_pct));
  }

  // Лучший (минимальный) тир среди участников — для тай-брейка ранжирования.
  const minTier = (g: MutableGroup): number =>
    g.members.reduce(
      (acc, m) =>
        Math.min(acc, typeof m.tier === 'number' && Number.isFinite(m.tier) ? m.tier : Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );

  groups.sort(
    (a, b) =>
      b.potential_pct - a.potential_pct ||
      b.members.length - a.members.length ||
      minTier(a) - minTier(b) ||
      a.name.localeCompare(b.name),
  );
  groups.forEach((g, i) => {
    g.rank = i + 1;
  });

  return groups.map((g) => ({
    name: g.name,
    summary: g.summary,
    synonyms: g.synonyms,
    memberTitles: g.memberTitles,
    potential_pct: g.potential_pct,
    rank: g.rank,
  }));
}

/* ───────────────── Стадия ───────────────── */

export async function runClusteringStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();

  const { data: hyps, error } = await ctx.supabase
    .from('he_hypotheses')
    .select('*')
    .eq('project_id', job.project_id)
    .order('potential_pct', { ascending: false });
  if (error) throw new Error(`he_hypotheses read: ${error.message}`);
  const hypotheses = (hyps ?? []) as HeHypothesis[];
  if (!hypotheses.length) {
    throw new Error('Нет верифицированных гипотез: сначала выполните стадию evidence');
  }

  const llm = await callLLMWithSchema(
    buildClusteringMessages({
      hypotheses: hypotheses.map((h) => ({
        title: h.title,
        tier: h.tier,
        description: h.description,
        potential_pct: h.potential_pct,
        evidence_count: Array.isArray(h.evidence) ? h.evidence.length : 0,
      })),
    }),
    HeClusteringSchema,
    { model: getHeModel('research'), maxTokens: 8192 },
  );
  addUsage(usage, llm);

  const verticals = applyClusteringDecisions(hypotheses, llm.data.verticals);
  stageLog(ctx, `[clustering] вертикалей: ${verticals.length} из ${hypotheses.length} гипотез`);

  // Идемпотентная перезапись: отвязываем гипотезы, сносим старые вертикали.
  const { error: unlinkError } = await ctx.supabase
    .from('he_hypotheses')
    .update({ vertical_id: null })
    .eq('project_id', job.project_id);
  if (unlinkError) throw new Error(`he_hypotheses unlink: ${unlinkError.message}`);
  const { error: delError } = await ctx.supabase
    .from('he_verticals')
    .delete()
    .eq('project_id', job.project_id);
  if (delError) throw new Error(`he_verticals cleanup: ${delError.message}`);

  const written: Array<AppliedVertical & { id: string }> = [];
  for (const v of verticals) {
    const { data: inserted, error: insError } = await ctx.supabase
      .from('he_verticals')
      .insert({
        project_id: job.project_id,
        name: v.name,
        summary: v.summary,
        synonyms: v.synonyms,
        potential_pct: v.potential_pct,
        rank: v.rank,
      })
      .select('id')
      .single();
    if (insError || !inserted) throw new Error(`he_verticals insert: ${insError?.message ?? 'unknown'}`);
    written.push({ ...v, id: (inserted as { id: string }).id });

    const { error: linkError } = await ctx.supabase
      .from('he_hypotheses')
      .update({ vertical_id: (inserted as { id: string }).id })
      .eq('project_id', job.project_id)
      .in('title', v.memberTitles);
    if (linkError) throw new Error(`he_hypotheses link: ${linkError.message}`);
  }

  const { error: projError } = await ctx.supabase
    .from('he_projects')
    .update({ status: 'researched', updated_at: new Date().toISOString() })
    .eq('id', job.project_id);
  if (projError) stageLog(ctx, `[clustering] project status update: ${projError.message}`);

  return { result: { verticals: written }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
