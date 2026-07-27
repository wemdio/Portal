/**
 * Стадия site_profile: фетч сайта клиента (SSRF-гейт + websiteParser) →
 * LLM-профиль → снапшот в he_projects.brief.site_profile, статус проекта
 * переводится в 'researching'.
 *
 * Дополнительно — наполнение кейс-банка (he_cases, source='site'): по тексту
 * сайта + до 3 очевидных кейс-страниц (/cases, /projects, /otzyvy, …) LLM
 * извлекает до 8 доказательных кейсов клиента. Replace-on-rerun: старые
 * site-кейсы проекта сносятся, загруженные вручную (source='upload') не
 * трогаются. Весь кейс-шаг best-effort: ошибка (LLM/БД/нет таблицы на
 * параллельном роллауте) логируется и НЕ роняет основную стадию.
 */

import { z } from 'zod';

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeSiteProfileSchema } from '../schemas';
import { heCaseDraftSchema } from '../caseBank';
import { buildSiteCaseExtractionMessages, buildSiteProfileMessages } from '../prompts/siteProfile';
import type { HeJob } from '../types';
import { resolveFetchText, type HeFetchTextFn } from './io';
import {
  addUsage,
  newUsage,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/** Локальная схема ответа LLM по кейсам (намеренно НЕ в schemas.ts). */
const HeSiteCasesSchema = z.object({
  cases: z.array(heCaseDraftSchema).max(8),
});

/** Очевидные пути кейс-страниц — слепой перебор на том же origin. */
const CASE_PAGE_PATHS = [
  '/cases',
  '/kejsy',
  '/projects',
  '/clients',
  '/portfolio',
  '/otzyvy',
  '/reviews',
  '/works',
];

/** Капы: не более 3 успешно скачанных кейс-страниц, не более 6 попыток. */
const MAX_EXTRA_PAGES = 3;
const MAX_PAGE_ATTEMPTS = 6;

/** Страница короче этого порога считается пустой/бесполезной. */
const MIN_PAGE_CHARS = 100;

/**
 * Дотянуть очевидные кейс-страницы (/cases, /projects, …) тем же fetchText,
 * что и главная. Каждая страница best-effort: 404/ошибка парсера — норма.
 */
async function fetchCasePages(
  fetchText: HeFetchTextFn,
  websiteUrl: string,
): Promise<Array<{ url: string; text: string }>> {
  let origin: string;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return [];
  }
  const pages: Array<{ url: string; text: string }> = [];
  let attempts = 0;
  for (const path of CASE_PAGE_PATHS) {
    if (pages.length >= MAX_EXTRA_PAGES || attempts >= MAX_PAGE_ATTEMPTS) break;
    attempts++;
    try {
      const text = await fetchText(origin + path);
      if (text && text.trim().length >= MIN_PAGE_CHARS) {
        pages.push({ url: origin + path, text });
      }
    } catch {
      /* страницы может не существовать — это ожидаемо */
    }
  }
  return pages;
}

/**
 * Кейс-шаг стадии (best-effort): LLM-извлечение до 8 кейсов →
 * replace-on-rerun в he_cases (только source='site' этого проекта).
 */
async function refreshSiteCases(
  ctx: HeStageContext,
  projectId: string,
  websiteUrl: string,
  siteText: string,
  fetchText: HeFetchTextFn,
): Promise<{ extracted: number; tokensUsed: number; costUsd: number }> {
  const extraPages = await fetchCasePages(fetchText, websiteUrl);
  stageLog(ctx, `[site_profile] кейс-страницы: ${extraPages.length}`);

  const llm = await callLLMWithSchema(
    buildSiteCaseExtractionMessages({ websiteUrl, siteText, extraPages }),
    HeSiteCasesSchema,
    { model: getHeModel('bulk'), maxTokens: 4096 },
  );
  const cases = llm.data.cases.slice(0, 8).filter((c) => c.text.trim().length > 0);

  // Replace-on-rerun: сносим только site-кейсы проекта, upload не трогаем.
  const { error: delError } = await ctx.supabase
    .from('he_cases')
    .delete()
    .eq('project_id', projectId)
    .eq('source', 'site');
  if (delError) throw new Error(`he_cases delete site: ${delError.message}`);

  if (cases.length) {
    const { error: insError } = await ctx.supabase.from('he_cases').insert(
      cases.map((c) => ({
        project_id: projectId,
        source: 'site',
        filename: null,
        industry: c.industry,
        client_type: c.client_type,
        task: c.task,
        metrics: c.metrics,
        result: c.result,
        text: c.text,
      })),
    );
    if (insError) throw new Error(`he_cases insert site: ${insError.message}`);
  }

  return { extracted: cases.length, tokensUsed: llm.tokensUsed, costUsd: llm.costUsd };
}

export async function runSiteProfileStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);

  const fetchText = resolveFetchText(ctx);
  stageLog(ctx, `[site_profile] фетч ${project.website_url}`);
  const siteText = await fetchText(project.website_url);
  stageLog(ctx, `[site_profile] получено ${siteText.length} символов, профиль…`);

  const llm = await callLLMWithSchema(
    buildSiteProfileMessages({ websiteUrl: project.website_url, siteText }),
    HeSiteProfileSchema,
    { model: getHeModel('research'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  const brief = {
    ...(project.brief ?? {}),
    website_url: project.website_url,
    site_profile: llm.data,
    captured_at: new Date().toISOString(),
  };
  const { error } = await ctx.supabase
    .from('he_projects')
    .update({ brief, status: 'researching', updated_at: new Date().toISOString() })
    .eq('id', project.id);
  if (error) throw new Error(`he_projects update brief: ${error.message}`);

  // Кейс-банк: best-effort — сбой не должен ронять основную стадию
  // (бриф уже сохранён; he_cases может ещё не существовать на роллауте).
  try {
    const casesResult = await refreshSiteCases(ctx, project.id, project.website_url, siteText, fetchText);
    usage.tokensUsed += casesResult.tokensUsed;
    usage.costUsd += casesResult.costUsd;
    stageLog(ctx, `[site_profile] кейсов извлечено: ${casesResult.extracted}`);
  } catch (e) {
    stageLog(ctx, `[site_profile] кейсы не извлечены: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { result: llm.data, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
