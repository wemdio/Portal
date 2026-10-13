/**
 * Стадия competitors: Serper-запросы из профиля + LLM → топ ~8 прямых
 * конкурентов (RU + международные) с URL из реальной выдачи; домашние
 * страницы конкурентов скачиваются (excerpt), сбои отдельных сайтов
 * пропускаются, не валят стадию. Результат пишется в job.result —
 * его читают стадии brand_cloud и hypotheses.
 *
 * Отмена задачи сбоем сайта НЕ считается: поиск и чтение ограничены сроком
 * (io.ts) и слушают сигнал джобы, а цикл на отмене прерывается — иначе после
 * нажатия «отменить» стадия дочитывала бы всех оставшихся конкурентов.
 *
 * Только market='us' (рынок 'ru' ищет и отбирает, как раньше):
 *  - запросы — не только по имени бренда, но и по категории продукта из
 *    профиля (product_category, stages/siteProfile.ts): у малоизвестной
 *    компании запросы «<имя> competitors» пусты, а по категории выдача
 *    находит тех, кто продаёт то же самое. Запросов столько же — 4;
 *  - пустой список конкурентов — честный исход, а не сбой схемы: стадия
 *    завершается с «конкурентов не найдено». Когда выдача пуста целиком,
 *    модель не вызывается вовсе — отбирать не из чего;
 *  - адрес каждого конкурента сверяется КОДОМ с выдачей: хост (без «www.»)
 *    обязан встретиться в ссылках найденных результатов, иначе конкурент
 *    отброшен — выдуманный домен до brand_cloud и гипотез не доходит. Сайт
 *    самого клиента отбрасывается так же.
 */

import { z } from 'zod';

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeCompetitorListSchema, type HeSiteProfileOutput } from '../schemas';
import { projectMarket } from '../market';
import { buildCompetitorsMessages } from '../prompts/competitors';
import { buildCompetitorsMessagesEn } from '../prompts/competitors.en';
import type { HeJob } from '../types';
import { heStageSignal, resolveFetchText, resolveSearch } from './io';
import {
  heSearchFailureStatus,
  heSearchStageFailure,
  newHeSearchTally,
  noteHeSearchAnswered,
  noteHeSearchFailure,
} from './searchIo';
import { heIoFailureReason } from '../operationDeadline';
import {
  addUsage,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  truncate,
  type HeStageContext,
  type HeStageResult,
} from './shared';

const MAX_COMPETITORS = 8;
const HOMEPAGE_EXCERPT = 1500;

/**
 * Ответ модели рынка 'us': тот же элемент, что у общего HeCompetitorListSchema,
 * но без нижнего порога — EN-промпт велит вернуть пустой список, когда прямых
 * конкурентов в выдаче нет, и общий .min(1) превращал этот честный ответ в
 * платный повтор и отказ стадии. Схема локальная: RU отбирает по общей.
 */
const HeCompetitorListSchemaUs = z.object({
  competitors: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
        why: z.string().default(''),
        geo: z.string().default(''),
      }),
    )
    .max(12),
});

/** Сколько слов категории продукта идёт в поисковый запрос. */
const CATEGORY_QUERY_MAX_WORDS = 8;

/** Категория продукта из профиля 'us' (product_category) или ''. */
function productCategoryOf(profile: HeSiteProfileOutput): string {
  const raw = (profile as HeSiteProfileOutput & { product_category?: unknown }).product_category;
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().split(' ').slice(0, CATEGORY_QUERY_MAX_WORDS).join(' ');
}

/**
 * Запросы рынка 'us': два по бренду и два по категории продукта, если
 * категория есть; без неё — прежние четыре по бренду. Повторы (регистр,
 * пробелы) и запросы без бренда при пустом имени выпадают: за каждый запрос
 * платим.
 */
function competitorQueriesUs(profile: HeSiteProfileOutput): string[] {
  const name = profile.company_name.trim();
  const category = productCategoryOf(profile);
  const raw = category
    ? [...(name ? [`${name} competitors`, `${name} vs`] : []), category, `${category} companies`]
    : name
      ? [`${name} competitors`, `${name} alternatives`, `${name} vs`, `${name} competitor comparison`]
      : [];
  const seen = new Set<string>();
  return raw.filter((q) => {
    const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Хост адреса без «www.» (для сверки с выдачей) или null, если адрес не http(s). */
function competitorHost(url: string): string | null {
  const trimmed = url.trim();
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export interface HeCompetitorEntry {
  name: string;
  url: string;
  why: string;
  geo: string;
  site_excerpt?: string;
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

/**
 * Сверка адресов рынка 'us': конкурент остаётся, только если хост его адреса
 * встретился в ссылках выдачи (промпт велит брать URL строго из поля link, а
 * здесь это проверяет код). Отбрасываются сайт самого клиента и повтор хоста;
 * каждый отброшенный — строкой лога. Адрес без схемы получает https://.
 */
function keepFoundCompetitors<T extends { name: string; url: string }>(
  ctx: HeStageContext,
  competitors: T[],
  searchResults: Array<{ items: Array<{ link: string }> }>,
  clientWebsite: string,
): T[] {
  const foundHosts = new Set<string>();
  for (const r of searchResults) {
    for (const item of r.items) {
      const host = competitorHost(item.link);
      if (host) foundHosts.add(host);
    }
  }
  const clientHost = competitorHost(clientWebsite);
  const takenHosts = new Set<string>();
  const kept: T[] = [];
  for (const c of competitors) {
    const host = competitorHost(c.url);
    const reason = !host
      ? 'адрес не разбирается'
      : host === clientHost
        ? 'это сайт самого клиента'
        : !foundHosts.has(host)
          ? 'хоста нет в выдаче поиска'
          : takenHosts.has(host)
            ? 'хост уже взят'
            : null;
    if (reason || !host) {
      stageLog(ctx, `[competitors] «${c.name}» (${c.url}) отброшен: ${reason}`);
      continue;
    }
    takenHosts.add(host);
    kept.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(c.url.trim()) ? c : { ...c, url: `https://${c.url.trim()}` });
  }
  return kept;
}

export async function runCompetitorsStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<HeSiteProfileOutput>(project);
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  const jobSignal = heStageSignal(ctx);
  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const queries =
    market === 'us'
      ? competitorQueriesUs(profile)
      : [
          `${profile.company_name} конкуренты`,
          `${profile.company_name} аналоги альтернативы`,
          `${profile.company_name} competitors`,
          `${profile.company_name} vs`,
        ];

  const searchResults: Array<{ query: string; items: Array<{ title: string; link: string; snippet?: string }> }> = [];
  const tally = newHeSearchTally();
  for (const q of queries) {
    let items: Array<{ title: string; link: string; snippet?: string }> = [];
    try {
      items = await search(q);
      // Обслуженный запрос — даже с пустой выдачей: по одному-двум пустым
      // запросам конкурентов отбирать можно, по нулю обслуженных — нет.
      noteHeSearchAnswered(tally);
    } catch (e) {
      if (jobSignal?.aborted) throw e;
      noteHeSearchFailure(tally, e);
      stageLog(ctx, `[competitors] поиск «${q}» упал: ${heIoFailureReason(e)}`);
    }
    searchResults.push({ query: q, items });
  }
  // Ни один запрос не обслужен — списка конкурентов взять НЕОТКУДА. Раньше
  // стадия шла дальше: модель придумывала конкурентов из приоров, стадия
  // завершалась успехом, а платить за неё приходилось как за исследование.
  //
  // Перманентный отказ (деньги, ключ) останавливает стадию и тогда, когда часть
  // запросов обслужена: дальше по конвейеру идут brand_cloud и evidence с
  // десятками поисков, и ни один из них уже не получит выдачи — исследование
  // доехало бы до конца на приорах модели. Одна честно пустая выдача среди
  // обслуженных стадию не трогает (см. HeSearchTally).
  const searchFailure = heSearchStageFailure(tally);
  if (searchFailure) {
    stageLog(
      ctx,
      `[competitors] поиск отказал (обслужено ${tally.answered} из ${queries.length} запросов) — `
        + `стадия остановлена до вызова модели: `
        + `${heIoFailureReason(searchFailure)}${heSearchFailureStatus(searchFailure)}`,
    );
    throw searchFailure;
  }
  // Рынок 'us': выдача пуста целиком (или запросов нет — ни имени, ни
  // категории) — отбирать не из чего, и платный вызов модели ничего бы не
  // добавил: адрес из пустой выдачи сверку ниже не пройдёт.
  if (market === 'us' && !searchResults.some((r) => r.items.length > 0)) {
    stageLog(
      ctx,
      `[competitors] выдача пуста (запросов: ${queries.length}) — конкурентов не найдено, модель не вызываем`,
    );
    return { result: { competitors: [] }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
  }
  stageLog(ctx, `[competitors] выдача собрана, отбор LLM…`);

  const competitorsInput = { profile, websiteUrl: project.website_url, searchResults };
  const competitorsOptions = { model: getHeModel('research'), maxTokens: 4096 };
  const llm = market === 'us'
    ? await callLLMWithSchema(
        buildCompetitorsMessagesEn(competitorsInput),
        HeCompetitorListSchemaUs,
        competitorsOptions,
      )
    : await callLLMWithSchema(buildCompetitorsMessages(competitorsInput), HeCompetitorListSchema, competitorsOptions);
  addUsage(usage, llm);

  const answered = market === 'us'
    ? keepFoundCompetitors(ctx, llm.data.competitors, searchResults, project.website_url)
    : llm.data.competitors;
  const selected = answered.slice(0, MAX_COMPETITORS);
  if (market === 'us' && !selected.length) {
    stageLog(ctx, '[competitors] конкурентов не найдено — стадия завершена с пустым списком');
  }
  const competitors: HeCompetitorEntry[] = [];
  // Подпись прогресса уезжает в he_jobs.progress.label и печатается клиенту
  // как есть (блок «Right now» кабинета ENG), поэтому зависит от рынка, а не
  // переводится насовсем: тот же V1 обслуживает русский внутренний инструмент.
  const progressLabel = market === 'us' ? 'studying a competitor' : 'изучаем конкурента';
  for (let i = 0; i < selected.length; i += 1) {
    const c = selected[i];
    await reportProgress(ctx, job.id, i + 1, selected.length, progressLabel);
    const entry: HeCompetitorEntry = { name: c.name, url: c.url, why: c.why, geo: c.geo };
    try {
      entry.site_excerpt = truncate(await fetchText(c.url), HOMEPAGE_EXCERPT);
    } catch (e) {
      if (jobSignal?.aborted) throw e;
      stageLog(ctx, `[competitors] фетч ${c.url} пропущен: ${heIoFailureReason(e)}`);
    }
    competitors.push(entry);
  }

  return { result: { competitors }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
