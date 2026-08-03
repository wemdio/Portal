/**
 * Стадия site_profile: фетч сайта клиента (SSRF-гейт + websiteParser) →
 * LLM-профиль → снапшот в he_projects.brief.site_profile, статус проекта
 * переводится в 'researching'.
 *
 * Дополнительно — наполнение кейс-банка (he_cases, source='site'): по тексту
 * сайта + до 3 очевидных кейс-страниц (/cases, /case-studies, /otzyvy, …)
 * LLM извлекает до 8 доказательных кейсов клиента (дедуп по нормализованному
 * тексту). Refresh атомарный: новые кейсы вставляются первыми, затем
 * удаляются устаревшие site-строки проекта (не совпавшие по нормализованному
 * тексту); при пустой выборке или сбое вставки старые кейсы сохраняются.
 * Загруженные вручную (source='upload') не трогаются. Весь кейс-шаг
 * best-effort: ошибка (LLM/БД/нет таблицы на параллельном роллауте)
 * логируется и НЕ роняет основную стадию.
 *
 * Локализация: при he_projects.market='us' оба LLM-вызова идут EN-промптами
 * (prompts/siteProfile.en), иначе — RU (обратная совместимость).
 */

import { z } from 'zod';

import { callLLMWithSchema, getHeModel } from '../llm';
import { projectMarket, type HeMarket } from '../market';
import { HeSiteProfileSchema } from '../schemas';
import { heCaseDraftSchema, normalizeCaseText } from '../caseBank';
import { buildSiteCaseExtractionMessages, buildSiteProfileMessages } from '../prompts/siteProfile';
import {
  buildSiteCaseExtractionMessagesEn,
  buildSiteProfileMessagesEn,
} from '../prompts/siteProfile.en';
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

/**
 * Очевидные пути кейс-страниц — слепой перебор на том же origin. Список
 * общий для обоих рынков: EN-пути (/case-studies, /testimonials, /customers)
 * перемешаны с RU — для RU-сайтов они безвредны (404 — ожидаемая норма),
 * а порядок задаёт приоритет в пределах MAX_PAGE_ATTEMPTS.
 */
export const CASE_PAGE_PATHS = [
  '/cases',
  '/case-studies',
  '/kejsy',
  '/projects',
  '/testimonials',
  '/clients',
  '/portfolio',
  '/customers',
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
 * Кейс-шаг стадии (best-effort): LLM-извлечение до 8 кейсов → атомарный
 * refresh в he_cases (только source='site' этого проекта): insert новых
 * первым, затем delete устаревших site-строк вне свежего набора.
 */
async function refreshSiteCases(
  ctx: HeStageContext,
  projectId: string,
  websiteUrl: string,
  siteText: string,
  fetchText: HeFetchTextFn,
  market: HeMarket,
): Promise<{ extracted: number; tokensUsed: number; costUsd: number }> {
  const extraPages = await fetchCasePages(fetchText, websiteUrl);
  stageLog(ctx, `[site_profile] кейс-страницы: ${extraPages.length}`);

  const casesInput = { websiteUrl, siteText, extraPages };
  const llm = await callLLMWithSchema(
    market === 'us'
      ? buildSiteCaseExtractionMessagesEn(casesInput)
      : buildSiteCaseExtractionMessages(casesInput),
    HeSiteCasesSchema,
    { model: getHeModel('bulk'), maxTokens: 4096 },
  );
  // Дедуп по нормализованному тексту: главная и /cases часто описывают один
  // и тот же кейс — без дедупа он вставился бы дважды.
  const seen = new Set<string>();
  const cases = llm.data.cases
    .slice(0, 8)
    .filter((c) => c.text.trim().length > 0)
    .filter((c) => {
      const key = normalizeCaseText(c.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Пустая выборка — ничего не удаляем: старые site-кейсы сохраняются.
  if (!cases.length) {
    return { extracted: 0, tokensUsed: llm.tokensUsed, costUsd: llm.costUsd };
  }

  // Insert-first: сначала новые строки — при сбое вставки старые site-кейсы
  // проекта остаются на месте (delete-then-insert терял бы их все).
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

  // Затем чистим устаревшие: site-кейсы проекта, чей нормализованный текст не
  // вошёл в только что вставленный набор (совпавшие — те же кейсы, остаются
  // в одном экземпляре). Upload-кейсы не трогаем.
  const freshKeys = new Set(cases.map((c) => normalizeCaseText(c.text)));
  const { data: siteRows, error: readError } = await ctx.supabase
    .from('he_cases')
    .select('id, text')
    .eq('project_id', projectId)
    .eq('source', 'site');
  if (readError) throw new Error(`he_cases read site: ${readError.message}`);
  const staleIds = ((siteRows ?? []) as Array<{ id: string; text: string | null }>)
    .filter((r) => !freshKeys.has(normalizeCaseText(r.text ?? '')))
    .map((r) => r.id);
  if (staleIds.length) {
    const { error: delError } = await ctx.supabase.from('he_cases').delete().in('id', staleIds);
    if (delError) throw new Error(`he_cases delete stale site: ${delError.message}`);
  }

  return { extracted: cases.length, tokensUsed: llm.tokensUsed, costUsd: llm.costUsd };
}

export async function runSiteProfileStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const market = projectMarket(project);

  const fetchText = resolveFetchText(ctx);
  stageLog(ctx, `[site_profile] фетч ${project.website_url}`);
  const siteText = await fetchText(project.website_url);
  stageLog(ctx, `[site_profile] получено ${siteText.length} символов, профиль…`);

  const profileInput = { websiteUrl: project.website_url, siteText };
  const llm = await callLLMWithSchema(
    market === 'us' ? buildSiteProfileMessagesEn(profileInput) : buildSiteProfileMessages(profileInput),
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
    const casesResult = await refreshSiteCases(ctx, project.id, project.website_url, siteText, fetchText, market);
    usage.tokensUsed += casesResult.tokensUsed;
    usage.costUsd += casesResult.costUsd;
    stageLog(ctx, `[site_profile] кейсов извлечено: ${casesResult.extracted}`);
  } catch (e) {
    stageLog(ctx, `[site_profile] кейсы не извлечены: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { result: llm.data, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
