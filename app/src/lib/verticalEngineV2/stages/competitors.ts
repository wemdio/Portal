/**
 * Стадия competitors: Serper-запросы из профиля + LLM → топ ~8 прямых
 * конкурентов (RU + международные) с URL из реальной выдачи; домашние
 * страницы конкурентов скачиваются (excerpt), сбои отдельных сайтов
 * пропускаются, не валят стадию. Результат пишется в job.result —
 * его читают стадии brand_cloud и hypotheses.
 */

import { callLLMWithSchema, getVeModel } from '../llm';
import { VeCompetitorListSchema, type VeSiteProfileOutput } from '../schemas';
import { projectMarket } from '../market';
import { buildCompetitorsMessages } from '../prompts/competitors';
import { buildCompetitorsMessagesEn } from '../prompts/competitors.en';
import type { VeJob } from '../types';
import { resolveFetchText, resolveSearch } from './io';
import {
  addUsage,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  truncate,
  type VeStageContext,
  type VeStageResult,
} from './shared';

const MAX_COMPETITORS = 8;
const HOMEPAGE_EXCERPT = 1500;

export interface VeCompetitorEntry {
  name: string;
  url: string;
  why: string;
  geo: string;
  site_excerpt?: string;
}

/**
 * Живой прогресс стадии → ve_jobs.progress ({done, total, label}); его
 * показывает UI шага «Исследование». Best-effort: сбой обновления
 * не должен валить стадию.
 */
async function reportProgress(
  ctx: VeStageContext,
  jobId: string,
  done: number,
  total: number,
  label: string,
): Promise<void> {
  try {
    await ctx.supabase
      .from('ve_jobs')
      .update({ progress: { done, total, label } })
      .eq('id', jobId);
  } catch {
    // прогресс — best-effort, сбой игнорируем
  }
}

export async function runCompetitorsStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<VeSiteProfileOutput>(project);
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  // Рынок: ctx.market (воркер), фолбэк — колонка ve_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const queries =
    market === 'us'
      ? [
          `${profile.company_name} competitors`,
          `${profile.company_name} alternatives`,
          `${profile.company_name} vs`,
          `${profile.company_name} competitor comparison`,
        ]
      : [
          `${profile.company_name} конкуренты`,
          `${profile.company_name} аналоги альтернативы`,
          `${profile.company_name} competitors`,
          `${profile.company_name} vs`,
        ];

  const searchResults: Array<{ query: string; items: Array<{ title: string; link: string; snippet?: string }> }> = [];
  for (const q of queries) {
    let items: Array<{ title: string; link: string; snippet?: string }> = [];
    try {
      items = await search(q);
    } catch (e) {
      stageLog(ctx, `[competitors] поиск «${q}» упал: ${e instanceof Error ? e.message : String(e)}`);
    }
    searchResults.push({ query: q, items });
  }
  stageLog(ctx, `[competitors] выдача собрана, отбор LLM…`);

  const llm = await callLLMWithSchema(
    (market === 'us' ? buildCompetitorsMessagesEn : buildCompetitorsMessages)({
      profile,
      websiteUrl: project.website_url,
      searchResults,
    }),
    VeCompetitorListSchema,
    { model: getVeModel('research'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  const selected = llm.data.competitors.slice(0, MAX_COMPETITORS);
  const competitors: VeCompetitorEntry[] = [];
  for (let i = 0; i < selected.length; i += 1) {
    const c = selected[i];
    await reportProgress(ctx, job.id, i + 1, selected.length, 'изучаем конкурента');
    const entry: VeCompetitorEntry = { name: c.name, url: c.url, why: c.why, geo: c.geo };
    try {
      entry.site_excerpt = truncate(await fetchText(c.url), HOMEPAGE_EXCERPT);
    } catch (e) {
      stageLog(ctx, `[competitors] фетч ${c.url} пропущен: ${e instanceof Error ? e.message : String(e)}`);
    }
    competitors.push(entry);
  }

  return { result: { competitors }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
