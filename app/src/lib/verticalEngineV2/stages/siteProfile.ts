/**
 * Стадия site_profile: фетч сайта клиента (SSRF-гейт + websiteParser) →
 * докачка контентных страниц (/about, /uslugi, /prices, …, корпус до ~12k
 * символов — профиль по одной главной давал усреднённые гипотезы) →
 * LLM-профиль → снапшот в ve_projects.brief.site_profile, статус проекта
 * переводится в 'researching'. Тонкий/JS-сайт (мало текста или заглушка
 * парсера) помечается brief.site_thin — UI просит ручное описание бизнеса
 * (business_override), которое стадия hypotheses кладёт в промпт поверх
 * профиля.
 *
 * Дополнительно — наполнение кейс-банка (ve_cases, source='site'): по тексту
 * сайта + до 3 очевидных кейс-страниц (/cases, /case-studies, /otzyvy, …)
 * LLM извлекает до 8 доказательных кейсов клиента (дедуп по нормализованному
 * тексту). Refresh атомарный: новые кейсы вставляются первыми, затем
 * удаляются устаревшие site-строки проекта (не совпавшие по нормализованному
 * тексту); при пустой выборке или сбое вставки старые кейсы сохраняются.
 * Загруженные вручную (source='upload') не трогаются. Весь кейс-шаг
 * best-effort: ошибка (LLM/БД/нет таблицы на параллельном роллауте)
 * логируется и НЕ роняет основную стадию.
 *
 * Локализация: при ve_projects.market='us' оба LLM-вызова идут EN-промптами
 * (prompts/siteProfile.en), иначе — RU (обратная совместимость).
 */

import { z } from 'zod';

import { callLLMWithSchema, getVeModel } from '../llm';
import { compileClientBriefForPrompt, readClientBrief } from '../clientBriefIntake';
import { projectMarket, type VeMarket } from '../market';
import { VeSiteProfileSchema } from '../schemas';
import { heCaseDraftSchema, normalizeCaseText } from '../caseBank';
import { buildSiteCaseExtractionMessages, buildSiteProfileMessages } from '../prompts/siteProfile';
import {
  buildSiteCaseExtractionMessagesEn,
  buildSiteProfileMessagesEn,
} from '../prompts/siteProfile.en';
import type { VeJob } from '../types';
import { resolveFetchText, type VeFetchTextFn } from './io';
import {
  addUsage,
  newUsage,
  readProject,
  stageLog,
  type VeStageContext,
  type VeStageResult,
} from './shared';

/** Локальная схема ответа LLM по кейсам (намеренно НЕ в schemas.ts). */
const VeSiteCasesSchema = z.object({
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
 * Контентные страницы для профиля бизнеса: «о компании», услуги, цены,
 * продукты. Профиль, построенный на одной главной (≤3000 символов), даёт
 * усреднённые гипотезы из приоров модели — докачиваем до 4 страниц в корпус.
 */
export const CONTENT_PAGE_PATHS = [
  '/about',
  '/o-nas',
  '/company',
  '/about-us',
  '/o-kompanii',
  '/uslugi',
  '/services',
  '/prices',
  '/tseny',
  '/products',
  '/solutions',
  '/resheniya',
];

/** Капы контентной докачки: ≤4 успешных страниц, ≤8 попыток (оба списка). */
const MAX_CONTENT_PAGES = 4;
const MAX_CONTENT_ATTEMPTS = 8;
/** Символов на доп. страницу в корпусе профиля; общий кап корпуса. */
const EXTRA_PAGE_EXCERPT = 2500;
const MAX_PROFILE_CORPUS = 12000;
/** Корпус короче порога (или JS-заглушка) → сайт «тонкий», нужен ручной бриф. */
const THIN_SITE_CHARS = 800;
const JS_STUB_MARK = 'требует JavaScript';

/**
 * Дотянуть контентные + кейс-страницы тем же fetchText, что и главная.
 * Бюджеты РАЗДЕЛЬНЫЕ: контентные пути (12 шт) не съедают попытки кейс-путей —
 * иначе кейс-страницы недостижимы вообще (8 попыток < 12 контентных путей).
 * Каждая страница best-effort: 404/ошибка парсера — норма.
 */
async function fetchExtraPages(
  fetchText: VeFetchTextFn,
  websiteUrl: string,
): Promise<{ content: Array<{ url: string; text: string }>; cases: Array<{ url: string; text: string }> }> {
  let origin: string;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return { content: [], cases: [] };
  }
  const fetchPath = async (path: string): Promise<{ url: string; text: string } | null> => {
    try {
      const text = await fetchText(origin + path);
      if (text && text.trim().length >= MIN_PAGE_CHARS) return { url: origin + path, text };
    } catch {
      /* страницы может не существовать — это ожидаемо */
    }
    return null;
  };

  const content: Array<{ url: string; text: string }> = [];
  let contentAttempts = 0;
  for (const path of CONTENT_PAGE_PATHS) {
    if (content.length >= MAX_CONTENT_PAGES || contentAttempts >= MAX_CONTENT_ATTEMPTS) break;
    contentAttempts++;
    const page = await fetchPath(path);
    if (page) content.push(page);
  }

  const cases: Array<{ url: string; text: string }> = [];
  let caseAttempts = 0;
  for (const path of CASE_PAGE_PATHS) {
    if (cases.length >= MAX_EXTRA_PAGES || caseAttempts >= MAX_PAGE_ATTEMPTS) break;
    caseAttempts++;
    const page = await fetchPath(path);
    if (page) cases.push(page);
  }
  return { content, cases };
}

/** Корпус профиля: главная + контентные страницы с маркерами URL, с капом. */
function buildProfileCorpus(siteText: string, extraPages: Array<{ url: string; text: string }>): string {
  let corpus = siteText;
  for (const page of extraPages) {
    if (corpus.length >= MAX_PROFILE_CORPUS) break;
    corpus += `\n\n=== ${page.url} ===\n${page.text.slice(0, EXTRA_PAGE_EXCERPT)}`;
  }
  return corpus.slice(0, MAX_PROFILE_CORPUS);
}

/**
 * Дотянуть очевидные кейс-страницы (/cases, /projects, …) тем же fetchText,
 * что и главная. Каждая страница best-effort: 404/ошибка парсера — норма.
 */
async function fetchCasePages(
  fetchText: VeFetchTextFn,
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
 * refresh в ve_cases (только source='site' этого проекта): insert новых
 * первым, затем delete устаревших site-строк вне свежего набора.
 */
async function refreshSiteCases(
  ctx: VeStageContext,
  projectId: string,
  websiteUrl: string,
  siteText: string,
  fetchText: VeFetchTextFn,
  market: VeMarket,
  prefetchedPages?: Array<{ url: string; text: string }>,
): Promise<{ extracted: number; tokensUsed: number; costUsd: number }> {
  // Страницы уже скачанных кейс-путей переиспользуем (стадия качала их для
  // корпуса профиля); не переданы — старый слепой перебор.
  const extraPages = prefetchedPages ?? (await fetchCasePages(fetchText, websiteUrl));
  stageLog(ctx, `[site_profile] кейс-страницы: ${extraPages.length}`);

  const casesInput = { websiteUrl, siteText, extraPages };
  const llm = await callLLMWithSchema(
    market === 'us'
      ? buildSiteCaseExtractionMessagesEn(casesInput)
      : buildSiteCaseExtractionMessages(casesInput),
    VeSiteCasesSchema,
    { model: getVeModel('bulk'), maxTokens: 4096 },
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
  const { error: insError } = await ctx.supabase.from('ve_cases').insert(
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
  if (insError) throw new Error(`ve_cases insert site: ${insError.message}`);

  // Затем чистим устаревшие: site-кейсы проекта, чей нормализованный текст не
  // вошёл в только что вставленный набор (совпавшие — те же кейсы, остаются
  // в одном экземпляре). Upload-кейсы не трогаем.
  const freshKeys = new Set(cases.map((c) => normalizeCaseText(c.text)));
  const { data: siteRows, error: readError } = await ctx.supabase
    .from('ve_cases')
    .select('id, text')
    .eq('project_id', projectId)
    .eq('source', 'site');
  if (readError) throw new Error(`ve_cases read site: ${readError.message}`);
  const staleIds = ((siteRows ?? []) as Array<{ id: string; text: string | null }>)
    .filter((r) => !freshKeys.has(normalizeCaseText(r.text ?? '')))
    .map((r) => r.id);
  if (staleIds.length) {
    const { error: delError } = await ctx.supabase.from('ve_cases').delete().in('id', staleIds);
    if (delError) throw new Error(`ve_cases delete stale site: ${delError.message}`);
  }

  return { extracted: cases.length, tokensUsed: llm.tokensUsed, costUsd: llm.costUsd };
}

export async function runSiteProfileStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const market = projectMarket(project);

  const fetchText = resolveFetchText(ctx);
  stageLog(ctx, `[site_profile] фетч ${project.website_url}`);
  const siteText = await fetchText(project.website_url);
  // Докачка контентных/кейс-страниц: профиль по одной главной (≤3000 символов)
  // — уровень «прочитал билборд» и даёт усреднённые гипотезы. Кейс-страницы
  // из этой же пачки уходят в refreshSiteCases (без повторных фетчей).
  const extraPages = await fetchExtraPages(fetchText, project.website_url);
  const corpusPages = [...extraPages.content, ...extraPages.cases];
  stageLog(
    ctx,
    `[site_profile] главная ${siteText.length} символов + ${corpusPages.length} доп. страниц (кейс: ${extraPages.cases.length}), профиль…`,
  );
  const corpus = buildProfileCorpus(siteText, corpusPages);

  // Гейт «тонкого» сайта: текста мало или пришла JS-заглушка парсера →
  // помечаем в brief (UI просит ручное описание бизнеса, business_override).
  const siteThin = corpus.length < THIN_SITE_CHARS || siteText.includes(JS_STUB_MARK);
  if (siteThin) {
    stageLog(ctx, `[site_profile] сайт тонкий (${corpus.length} символов) — помечен site_thin`);
  }

  // Бриф клиента — второй источник профиля: закрывает то, чего на сайте нет
  // (цикл сделки, чек, возражения), и остаётся единственным источником, когда
  // сайт «в разработке».
  const clientBrief = compileClientBriefForPrompt(readClientBrief(project));
  if (clientBrief) stageLog(ctx, '[site_profile] бриф клиента подмешан в профиль');

  const profileInput = { websiteUrl: project.website_url, siteText: corpus, clientBrief };
  const llm = await callLLMWithSchema(
    market === 'us' ? buildSiteProfileMessagesEn(profileInput) : buildSiteProfileMessages(profileInput),
    VeSiteProfileSchema,
    { model: getVeModel('research'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  // Brief перечитываем прямо перед записью: за минуты LLM-вызовов пользователь
  // мог сохранить overrides (offer/style/signature/business) через PATCH —
  // спред от протухшего снапшота их бы затёр.
  const { data: freshProject } = await ctx.supabase
    .from('ve_projects')
    .select('brief')
    .eq('id', project.id)
    .single();
  const brief = {
    ...(((freshProject as { brief?: Record<string, unknown> } | null)?.brief) ?? project.brief ?? {}),
    website_url: project.website_url,
    site_profile: llm.data,
    site_thin: siteThin,
    site_text_chars: corpus.length,
    captured_at: new Date().toISOString(),
  };
  const { error } = await ctx.supabase
    .from('ve_projects')
    .update({ brief, status: 'researching', updated_at: new Date().toISOString() })
    .eq('id', project.id);
  if (error) throw new Error(`ve_projects update brief: ${error.message}`);

  // Кейс-банк: best-effort — сбой не должен ронять основную стадию
  // (бриф уже сохранён; ve_cases может ещё не существовать на роллауте).
  try {
    const casesResult = await refreshSiteCases(
      ctx,
      project.id,
      project.website_url,
      siteText,
      fetchText,
      market,
      extraPages.cases,
    );
    usage.tokensUsed += casesResult.tokensUsed;
    usage.costUsd += casesResult.costUsd;
    stageLog(ctx, `[site_profile] кейсов извлечено: ${casesResult.extracted}`);
  } catch (e) {
    stageLog(ctx, `[site_profile] кейсы не извлечены: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { result: llm.data, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
