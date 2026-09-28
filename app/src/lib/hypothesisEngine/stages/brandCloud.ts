/**
 * Стадия brand_cloud: по клиенту и каждому конкуренту извлекает «brand
 * cloud» (кейсы, логотипы клиентов, отзывы, пресса) и классифицирует
 * сущности: anomaly / noise / potential + %. Результат — в job.result,
 * его читает стадия hypotheses.
 *
 * Поиск и чтение ограничены сроком (io.ts). Пустая выдача и НЕ отдавший ответ
 * в срок поиск — разные исходы: второй пишется в лог отдельной строкой, иначе
 * зависший провайдер выглядит как бренд без следов. Отмена задачи прерывает
 * перебор брендов, а не пропускает один бренд.
 *
 * Отказ ДОСТУПА к провайдеру (поиск: деньги/ключ; модель: деньги/ключ/лимит
 * частоты) прерывает перебор так же, как отмена: он перманентен для прогона, а
 * успешная стадия с пустым списком сущностей читается стадией hypotheses как
 * «следов бренда нет» — вывод о рынке вместо честного отказа. Так же прерывает
 * перебор и ПОЛНЫЙ отказ поиска (ни одного обслуженного бренда за два подряд):
 * платить вызовом модели за каждый следующий бренд не за что
 * (heSearchOutageFailure). Сбой ОДНОГО бренда (мёртвый сайт, пустая выдача, 4xx
 * на его же контексте) по-прежнему пропускается — см. HE_RUN_STOPPING_LLM_KINDS
 * ниже.
 */

import {
  callLLMWithSchema,
  getHeModel,
  heLlmFailureOf,
  type HeLlmFailureFacts,
  type HeLlmFailureKind,
} from '../llm';
import { HeBrandCloudSchema, type HeSiteProfileOutput } from '../schemas';
import { projectMarket, type HeMarket } from '../market';
import { buildBrandCloudMessages } from '../prompts/brandCloud';
import { buildBrandCloudMessagesEn } from '../prompts/brandCloud.en';
import type { HeJob } from '../types';
import { heStageSignal, resolveFetchText, resolveSearch } from './io';
import {
  heSearchFailureStatus,
  heSearchOutageFailure,
  heSearchStageFailure,
  newHeSearchTally,
  noteHeSearchAnswered,
  noteHeSearchFailure,
  type HeSearchTally,
} from './searchIo';
import { heIoFailureReason } from '../operationDeadline';
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

/**
 * Классы отказа ПРОВАЙДЕРА МОДЕЛИ, которые не лечатся следующим элементом
 * перебора и обязаны дойти до джобы.
 *
 * Дом политики один на две стадии с поэлементным платным вызовом (brand_cloud
 * по брендам, evidence по кандидатам): evidence импортирует предикат отсюда,
 * потому что две копии этого списка рано или поздно разойдутся, а расходятся
 * они деньгами.
 *
 *  - billing / configuration: нужен человек. Воркер умеет отказать по ним
 *    терминально (failJob, terminalProviderRefusal) — то есть НЕ переплатить
 *    стадию двумя лишними прогонами;
 *  - rate_limit: транспорт уже пересидел 429 внутри вызова (до 3 повторов,
 *    каждое ожидание ≤30 с) и всё равно получил отказ, значит окно провайдера
 *    длиннее просьбы, которую он присылал в Retry-After. Воркер
 *    умеет отодвинуть повтор до времени, которое назвал провайдер
 *    (failJob → rateLimitPauseMs, run_after, потолок паузы 10 минут). Попытку
 *    такая пауза ТРАТИТ — бесплатной стоянки в воркере нет намеренно, иначе
 *    стадия переплачивалась бы кратно MAX_ATTEMPTS (см. комментарий
 *    RATE_LIMIT_PAUSE_DEFAULT_MS в worker/hypothesisEngine.ts). Проглоченный
 *    здесь, 429 вместо этого выжигал весь перебор со скоростью сети.
 *
 * Absorbed по-прежнему: 'transient' (5xx, обрыв, битый конверт — соседний
 * элемент честно может ответить) и 'permanent' (прочие 4xx: это про ЭТОТ
 * запрос — слишком длинный контекст одного бренда, отказ фильтра содержимого).
 * Схемные сбои (LLMValidationError) и усечения тоже остаются поэлементными:
 * они про ответ модели, а не про доступ к ней.
 */
const HE_RUN_STOPPING_LLM_KINDS = new Set<HeLlmFailureKind>(['billing', 'configuration', 'rate_limit']);

/**
 * Факты отказа модели, если он останавливает весь прогон, — иначе null.
 * Читается ТИПОМ (heLlmFailureOf → дискриминант класса транспорта), никогда
 * регэкспом по тексту: в этом движке «aborted» означает отмену пользователем.
 */
export function heRunStoppingLlmFailure(error: unknown): HeLlmFailureFacts | null {
  const failure = heLlmFailureOf(error);
  return failure && HE_RUN_STOPPING_LLM_KINDS.has(failure.kind) ? failure : null;
}

/** Класс и код отказа модели для лога стадии. */
export function heLlmRefusalLabel(failure: HeLlmFailureFacts): string {
  return `${failure.kind}${failure.status ? `, HTTP ${failure.status}` : ''}`;
}

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
  tally: HeSearchTally,
): Promise<{ pages: Array<{ url: string; text: string }>; searchResults: Array<{ title: string; link: string; snippet?: string }> }> {
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  const jobSignal = heStageSignal(ctx);

  let searchResults: Array<{ title: string; link: string; snippet?: string }> = [];
  try {
    searchResults = await search(
      market === 'us' ? `"${target.name}" case studies clients reviews` : `"${target.name}" кейсы клиенты отзывы`,
    );
    // Пустая выдача по бренду — это факт о бренде (следов действительно нет);
    // отказ провайдера — отсутствие факта. Счётчик различает именно это.
    noteHeSearchAnswered(tally);
  } catch (e) {
    if (jobSignal?.aborted) throw e;
    noteHeSearchFailure(tally, e);
    // Сбой/срок поиска больше не выглядит как «по бренду ничего не нашлось».
    stageLog(ctx, `[brand_cloud] поиск по ${target.name} не дал выдачи: ${heIoFailureReason(e)}`);
    searchResults = [];
  }

  const pages: Array<{ url: string; text: string }> = [];
  try {
    pages.push({ url: target.url, text: truncate(await fetchText(target.url), HOMEPAGE_EXCERPT) });
  } catch (e) {
    if (jobSignal?.aborted) throw e;
    stageLog(ctx, `[brand_cloud] фетч главной ${target.url} пропущен: ${heIoFailureReason(e)}`);
  }

  const caseLinkPattern = market === 'us' ? CASE_LINK_PATTERN_EN : CASE_LINK_PATTERN_RU;
  const caseLink = searchResults.find((r) => caseLinkPattern.test(r.link))?.link;
  if (caseLink) {
    try {
      pages.push({ url: caseLink, text: truncate(await fetchText(caseLink), CASE_PAGE_EXCERPT) });
    } catch (e) {
      if (jobSignal?.aborted) throw e;
      stageLog(ctx, `[brand_cloud] фетч кейс-страницы ${caseLink} пропущен: ${heIoFailureReason(e)}`);
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

  const jobSignal = heStageSignal(ctx);
  const entities: BrandCloudEntity[] = [];
  // Подпись прогресса уезжает в he_jobs.progress.label и печатается клиенту
  // как есть (блок «Right now» кабинета ENG), поэтому зависит от рынка, а не
  // переводится насовсем: тот же V1 обслуживает русский внутренний инструмент.
  const progressLabel = market === 'us' ? 'mapping a brand' : 'разбираем бренд';
  const tally = newHeSearchTally();
  /**
   * Сколько брендов модель РАЗОБРАЛА (ответ прошёл схему) и первый проглоченный
   * сбой. Зачем: пустой список сущностей — утверждение «следов бренда нет», его
   * читает стадия hypotheses. Утверждать это можно по разобранным брендам, а не
   * по нулю ответов: ноль ответов — отсутствие факта, ровно как ноль обслуженных
   * запросов у поиска (heSearchStageFailure).
   */
  let brandsAnswered = 0;
  let firstModelFailure: unknown;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    await reportProgress(ctx, job.id, i + 1, targets.length, progressLabel);
    stageLog(ctx, `[brand_cloud] ${target.name}…`);
    const { pages, searchResults } = await collectBrandPages(target, ctx, market, tally);
    // Ниже — платный вызов модели на КАЖДЫЙ бренд, и половина его входа приходит
    // из поиска. Останавливаемся до вызова, пока перебор не сжёг бюджет модели
    // на пустом входе: отказ по деньгам/ключу сам не пройдёт, а поиск, не
    // обслуживший НИ ОДНОГО бренда за два подряд, лёг целиком
    // (heSearchOutageFailure). Пустая выдача по бренду — факт о бренде, и сюда
    // не попадает; одиночный блип не переживает следующего бренда.
    const outage = heSearchOutageFailure(tally, i + 1);
    if (outage) {
      stageLog(
        ctx,
        `[brand_cloud] поиск отказал (обслужено брендов: ${tally.answered}) — стадия остановлена `
          + `на ${target.name} (${i}/${targets.length}), до платного вызова модели: `
          + `${heIoFailureReason(outage)}${heSearchFailureStatus(outage)}`,
      );
      throw outage;
    }
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
      brandsAnswered += 1;
      for (const e of llm.data.entities) {
        entities.push({ ...e, source_brand: target.name });
      }
    } catch (e) {
      // Отмена задачи — не сбой одного бренда: продолжать перебор нельзя,
      // иначе отмена не останавливает расход на остальных брендах.
      if (jobSignal?.aborted) throw e;
      // Отказ ДОСТУПА к модели (деньги, ключ, лимит частоты) — тоже не сбой
      // одного бренда: следующий бренд получит тот же ответ. Раньше его
      // проглатывал этот catch, и класс, который транспорт выделил специально
      // для решения ДЖОБЫ, до неё не доходил: brand_cloud заканчивался УСПЕХОМ
      // с пустым списком сущностей, а стадия hypotheses читает это как «следов
      // бренда нет» — то есть отказ провайдера превращался в вывод о рынке.
      // Бросаем исходную ошибку: её тип нужен воркеру целым (park по 429,
      // терминальный отказ по 402/401).
      const refusal = heRunStoppingLlmFailure(e);
      if (refusal) {
        stageLog(
          ctx,
          `[brand_cloud] провайдер модели отказал (${heLlmRefusalLabel(refusal)}) — стадия остановлена `
            + `на ${target.name}, разобрано брендов: ${i}/${targets.length}: ${heIoFailureReason(e)}`,
        );
        throw e;
      }
      // Прочий сбой LLM по одному бренду не валит стадию — продолжаем по остальным.
      if (firstModelFailure === undefined) firstModelFailure = e;
      stageLog(ctx, `[brand_cloud] LLM по ${target.name} упал: ${heIoFailureReason(e)}`);
    }
  }

  // Ни один бренд не получил выдачи из-за провайдера: «следов бренда нет» было
  // бы ложью про все бренды сразу, а её читает стадия hypotheses.
  const searchFailure = heSearchStageFailure(tally);
  if (searchFailure) {
    stageLog(
      ctx,
      `[brand_cloud] поиск не обслужил ни один из ${targets.length} брендов — стадия остановлена: `
        + `${heIoFailureReason(searchFailure)}${heSearchFailureStatus(searchFailure)}`,
    );
    throw searchFailure;
  }

  // Ни один бренд не разобран моделью: пустой `entities` — это утверждение
  // «следов бренда нет», а его читает стадия hypotheses
  // (stages/hypotheses.ts:197, `brandCloudResult?.entities ?? []`). Утверждать
  // такое можно только по РАЗОБРАННЫМ брендам: ноль ответов — отсутствие факта,
  // ровно как ноль обслуженных запросов у поиска (heSearchStageFailure выше).
  // Без этой проверки прогон, в котором каждый бренд свалился поэлементным
  // сбоем (транзиент после всех повторов, дважды невалидная схема, 4xx на
  // контексте бренда), уходил в 'done' с пустым списком, he_jobs.error оставался
  // NULL, и hypotheses получала «рынок пуст» вместо честного отказа.
  // Бросаем ПЕРВЫЙ проглоченный сбой: его тип нужен воркеру целым, а первый —
  // тот, на котором прогон реально начал сыпаться.
  if (brandsAnswered === 0 && firstModelFailure !== undefined) {
    stageLog(
      ctx,
      `[brand_cloud] модель не разобрала ни один из ${targets.length} брендов — стадия остановлена `
        + `(пустой список сущностей читался бы как «следов бренда нет»): ${heIoFailureReason(firstModelFailure)}`,
    );
    throw firstModelFailure;
  }

  return { result: { entities }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
