/**
 * Стадия hypotheses — проход (a): мгновенный исчерпывающий список
 * гипотез-кандидатов (25–40, tier 1/2/3) из «генетической памяти» модели.
 * Кандидаты сохраняются в job.result.candidates — их верифицирует стадия
 * evidence. На этом шаге поиск и доказательства НЕ используются.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeHypothesesBatchSchema, type HeBrandCloudOutput, type HeSiteProfileOutput } from '../schemas';
import { buildHypothesesInstantMessages } from '../prompts/hypotheses';
import type { HeJob } from '../types';
import {
  addUsage,
  latestDoneJobResult,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';
import type { HeCompetitorEntry } from './competitors';

export async function runHypothesesStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<HeSiteProfileOutput>(project);

  const competitorsResult = await latestDoneJobResult<{ competitors?: HeCompetitorEntry[] }>(
    ctx.supabase,
    job.project_id,
    'competitors',
  );
  const competitors = (competitorsResult?.competitors ?? []).map((c) => ({
    name: c.name,
    url: c.url,
    why: c.why,
    geo: c.geo,
  }));

  const brandCloudResult = await latestDoneJobResult<{ entities?: HeBrandCloudOutput['entities'] }>(
    ctx.supabase,
    job.project_id,
    'brand_cloud',
  );
  const brandCloud = brandCloudResult?.entities ?? [];

  stageLog(ctx, '[hypotheses] мгновенный проход: 25–40 кандидатов…');
  const llm = await callLLMWithSchema(
    buildHypothesesInstantMessages({ profile, websiteUrl: project.website_url, brandCloud, competitors }),
    HeHypothesesBatchSchema,
    // 25–40 гипотез с description/fit_rationale/rationale/search_queries на
    // русском — кириллические BPE-токены дорогие, 8–16k обрезало бы JSON
    // посередине (поймали на проде: Unterminated string).
    { model: getHeModel('research'), maxTokens: 32768 },
  );
  addUsage(usage, llm);

  const candidates = llm.data.hypotheses;
  const tierCounts = candidates.reduce<Record<number, number>>((acc, h) => {
    acc[h.tier] = (acc[h.tier] ?? 0) + 1;
    return acc;
  }, {});
  stageLog(ctx, `[hypotheses] кандидатов: ${candidates.length} (tier: ${JSON.stringify(tierCounts)})`);

  return {
    result: { candidates, tier_counts: tierCounts },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
