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
 */

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
  stageLog(ctx, `[competitors] выдача собрана, отбор LLM…`);

  const llm = await callLLMWithSchema(
    (market === 'us' ? buildCompetitorsMessagesEn : buildCompetitorsMessages)({
      profile,
      websiteUrl: project.website_url,
      searchResults,
    }),
    HeCompetitorListSchema,
    { model: getHeModel('research'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  const selected = llm.data.competitors.slice(0, MAX_COMPETITORS);
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
