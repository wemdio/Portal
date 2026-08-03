/**
 * Стадия brand_cloud: по клиенту и каждому конкуренту извлекает «brand
 * cloud» (кейсы, логотипы клиентов, отзывы, пресса) и классифицирует
 * сущности: anomaly / noise / potential + %. Результат — в job.result,
 * его читает стадия hypotheses.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeBrandCloudSchema, type HeSiteProfileOutput } from '../schemas';
import { projectMarket, type HeMarket } from '../market';
import { buildBrandCloudMessages } from '../prompts/brandCloud';
import { buildBrandCloudMessagesEn } from '../prompts/brandCloud.en';
import type { HeJob } from '../types';
import { resolveFetchText, resolveSearch } from './io';
import {
  addUsage,
  latestDoneJobResult,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  truncate,
  type HeStageContext,
  type HeStageResult,
} from './shared';
import type { HeCompetitorEntry } from './competitors';

const MAX_TARGETS = 6; // клиент + до 5 конкурентов
const HOMEPAGE_EXCERPT = 1500;
const CASE_PAGE_EXCERPT = 2000;
const CASE_LINK_PATTERN_RU = /кейс|case|client|klient|отзыв|review|partner/i;
const CASE_LINK_PATTERN_EN = /case|client|customer|review|testimonial|partner|success/i;

interface BrandCloudEntity {
  name: string;
  kind: string;
  classification: 'anomaly' | 'noise' | 'potential';
  potential_pct: number;
  rationale: string;
  source_brand: string;
}

/**
 * Живой прогресс стадии → he_jobs.progress ({done, total, label}); его
 * показывает UI шага «Исследование». Best-effort: сбой обновления
 * не должен валить стадию.
 */
async function reportProgress(
  ctx: HeStageContext,
  jobId: string,
  done: number,
  total: number,
  label: string,
): Promise<void> {
  try {
    await ctx.supabase
      .from('he_jobs')
      .update({ progress: { done, total, label } })
      .eq('id', jobId);
  } catch {
    // прогресс — best-effort, сбой игнорируем
  }
}

async function collectBrandPages(
  target: { name: string; url: string },
  ctx: HeStageContext,
  market: HeMarket,
): Promise<{ pages: Array<{ url: string; text: string }>; searchResults: Array<{ title: string; link: string; snippet?: string }> }> {
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);

  let searchResults: Array<{ title: string; link: string; snippet?: string }> = [];
  try {
    searchResults = await search(
      market === 'us' ? `"${target.name}" case studies clients reviews` : `"${target.name}" кейсы клиенты отзывы`,
    );
  } catch {
    searchResults = [];
  }

  const pages: Array<{ url: string; text: string }> = [];
  try {
    pages.push({ url: target.url, text: truncate(await fetchText(target.url), HOMEPAGE_EXCERPT) });
  } catch (e) {
    stageLog(ctx, `[brand_cloud] фетч главной ${target.url} пропущен: ${e instanceof Error ? e.message : String(e)}`);
  }

  const caseLinkPattern = market === 'us' ? CASE_LINK_PATTERN_EN : CASE_LINK_PATTERN_RU;
  const caseLink = searchResults.find((r) => caseLinkPattern.test(r.link))?.link;
  if (caseLink) {
    try {
      pages.push({ url: caseLink, text: truncate(await fetchText(caseLink), CASE_PAGE_EXCERPT) });
    } catch (e) {
      stageLog(ctx, `[brand_cloud] фетч кейс-страницы ${caseLink} пропущен: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { pages, searchResults };
}

export async function runBrandCloudStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<HeSiteProfileOutput>(project);
  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const competitorsResult = await latestDoneJobResult<{ competitors?: HeCompetitorEntry[] }>(
    ctx.supabase,
    job.project_id,
    'competitors',
  );
  const competitorTargets = (competitorsResult?.competitors ?? []).slice(0, MAX_TARGETS - 1);

  const targets = [
    { name: profile.company_name, url: project.website_url },
    ...competitorTargets.map((c) => ({ name: c.name, url: c.url })),
  ];

  const entities: BrandCloudEntity[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    await reportProgress(ctx, job.id, i + 1, targets.length, 'разбираем бренд');
    stageLog(ctx, `[brand_cloud] ${target.name}…`);
    const { pages, searchResults } = await collectBrandPages(target, ctx, market);
    try {
      const llm = await callLLMWithSchema(
        (market === 'us' ? buildBrandCloudMessagesEn : buildBrandCloudMessages)({
          brandName: target.name,
          brandUrl: target.url,
          pages,
          searchResults,
        }),
        HeBrandCloudSchema,
        { model: getHeModel('bulk'), maxTokens: 4096 },
      );
      addUsage(usage, llm);
      for (const e of llm.data.entities) {
        entities.push({ ...e, source_brand: target.name });
      }
    } catch (e) {
      // Сбой LLM по одному бренду не валит стадию — продолжаем по остальным.
      stageLog(ctx, `[brand_cloud] LLM по ${target.name} упал: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { result: { entities }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
