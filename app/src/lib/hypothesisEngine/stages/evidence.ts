/**
 * Стадия evidence — проход (b): верификация каждого кандидата реальными
 * источниками. Для каждого кандидата: 2–4 таргетированных Serper-запроса,
 * фетч топ-1–2 источников, LLM-вердикт keep/merge/drop + массив доказательств
 * (claim + quote + URL только из найденного) + перекалиброванный %.
 * Принятые гипотезы пишутся в he_hypotheses (status='proposed').
 *
 * Устойчивость: сбой поиска → тонкие доказательства, стадия завершается;
 * сбой фетча источника → источник пропускается; сбой LLM по одному
 * кандидату → кандидат отбрасывается с reason='stage_error', остальные
 * продолжаются (на market='us' временный сбой модели и истёкший срок её
 * вызова — не отброс, а остановка прогона с чекпойнтом:
 * heEvidenceResumableLlmFailure; если это исполнение продвинуло чекпойнт,
 * остановка попытку джобы не тратит — HeEvidenceProgressResumeError; если
 * засчитанная остановка провалила бы джобу — последняя попытка, — кандидат
 * отбрасывается, как раньше, и прогон идёт дальше: heEvidenceStopFailsJob). Отмена
 * задачи под эти правила НЕ попадает: поиск и чтение ограничены сроком (io.ts)
 * и слушают сигнал джобы, а отменённая стадия
 * прерывается — отменённая гипотеза не должна уехать в статистику как
 * отброшенная (dropped), это разные исходы.
 *
 * Под эти правила НЕ попадает и отказ ДОСТУПА к провайдеру на рынке us (поиск:
 * деньги, ключ; модель: деньги, ключ, лимит частоты): он перманентен для
 * прогона, то есть повторится на каждом следующем кандидате, и стадия
 * прерывается ДО перезаписи he_hypotheses. Туда же — ПОЛНЫЙ отказ поиска (ни
 * одного обслуженного запроса за двух кандидатов подряд): «тонкие
 * доказательства» это про один кандидат, а не про прогон, у которого источников
 * нет вовсе. RU-проект (легаси /tools/hypothesis-engine) — как до порта ENG
 * (решение владельца 14.10.2026 «Как было»): любой отказ модели поглощается
 * поэлементно — кандидат уходит в stage_error, стадия кончается за одно
 * исполнение (политика — heRunStoppingLlmFailure в brandCloud.ts), а отказ
 * поиска приходит пустой выдачей (io.ts resolveSearch).
 *
 * Чекпойнт перебора (только market='us'): после каждого кандидата пройденный
 * префикс (принятые гипотезы и счётчики) пишется в he_jobs.result этой же
 * джобы, и повтор джобы — после паузы по 429, прерывания или обычного фейла —
 * продолжает с него. Вердикты, уже оплаченные вызовом ресёрч-модели, второй раз
 * не покупаются (как и поиск по их кандидатам). Механизм и его границы — у
 * HE_ITEM_CHECKPOINT_KEY в brandCloud.ts.
 *
 * Сама перезапись у market='us' стала условной: снос прошлых 'proposed'
 * гипотез проекта делается только если этот прогон принял хотя бы одну — иначе
 * ночь заменяла хороший набор пустым. RU-проект сносит прошлые
 * некластеризованные 'proposed' всегда, как до порта ENG.
 *
 * Кодовая верификация (verifyEvidence.ts): каждый evidence-пункт проверяется
 * против реально скачанных источников (URL ∈ fetched, цитата — подстрока
 * текста). Сфабрикованные пункты отбрасываются; гипотеза без проверенных
 * доказательств капается по % (≤ 20) — см. evidence_dropped в result.
 *
 * Только market='us' (рынок 'ru' ищет, читает и пишет, как раньше):
 *  - поиск: повторы среди запросов кандидата выпадают до оплаты; выдача каждого
 *    запроса — своя дорожка, и в промпт они идут вперемешку (takeRoundRobin, до
 *    MAX_SEARCH_ITEMS), а не «первые 8 от первого запроса», при которых платные
 *    запросы 2–3 выбрасывались;
 *  - источники: по одному на запрос, строгим чтением страницы (io.ts
 *    resolveFetchPage); не открылся верхний результат — берётся следующий того
 *    же запроса (fetchSourcesPerQuery);
 *  - в промпт уходит сегодняшняя дата (свежесть источников, без выдуманной
 *    сезонности — prompts/evidence.en.ts);
 *  - повтор research: гипотеза, которую человек уже разметил (accepted —
 *    рынок выбран, rejected — отклонён), не проверяется и не вставляется
 *    заново, а перезапись сносит ВСЕ прошлые 'proposed' проекта, в том числе
 *    уже привязанные к вертикалям прошлого прогона, — иначе они копились бы
 *    дублями рядом с новыми.
 */

import { z } from 'zod';

import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';

import { callLLMWithSchema, getHeModel, heLlmFailureOf, isHeLlmTimeout } from '../llm';
import {
  HeEvidenceItemSchema,
  HeEvidenceVerdictSchema,
  type HeEvidenceVerdict,
  type HeHypothesisCandidate,
  type HeSiteProfileOutput,
} from '../schemas';
import { projectMarket, type HeMarket } from '../market';
import { anchorPotentialPct } from '../scoreAnchor';
import { verifyEvidenceItems } from '../verifyEvidence';
import { buildEvidenceMessages } from '../prompts/evidence';
import { buildEvidenceMessagesEn, heTodayUtc } from '../prompts/evidence.en';
import type { HeEvidenceItem, HeHypothesisTier, HeJob } from '../types';
// Политика «какой отказ провайдера модели останавливает прогон» и чекпойнт
// перебора — одни на две стадии с поэлементным платным вызовом; их дом
// brandCloud.ts (там же docblock).
import {
  heItemCheckpointFingerprint,
  heLlmRefusalLabel,
  heRunStoppingLlmFailure,
  readHeItemCheckpoint,
  writeHeItemCheckpoint,
} from './brandCloud';
import { loadMarkupHistory, loadPortfolioProfile } from './hypotheses';
import { heStageSignal, resolveFetchPage, resolveFetchText, resolveSearch, type HeFetchPageFn } from './io';
import {
  heSearchFailureStatus,
  heSearchOutageFailure,
  heSearchStageFailure,
  newHeSearchTally,
  noteHeSearchAnswered,
  noteHeSearchFailure,
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

const MAX_QUERIES_PER_CANDIDATE = 3;
const MAX_SEARCH_ITEMS = 8;
const MAX_SOURCES_TO_FETCH = 2;
const SOURCE_EXCERPT = 1500;
const MAX_EVIDENCE_PER_HYPOTHESIS = 6;
/**
 * Источники рынка 'us' (fetchSourcesPerQuery): попыток чтения на один запрос —
 * верхний результат и следующий за ним — и на кандидата целиком. Худший срок
 * чтения кандидата — 5 строгих страниц по их сроку (io.ts, 38 с), а не 2 полных
 * цепочки fetchText (≈141 с каждая), как у 'ru'.
 */
const MAX_SOURCE_TRIES_PER_QUERY = 2;
const MAX_SOURCE_TRIES_PER_CANDIDATE = 5;
/** Текст короче — цитировать нечего (JS-заглушка, страница-пустышка). */
const MIN_SOURCE_CHARS = 100;

type HeSearchItem = { title: string; link: string; snippet?: string };

interface AcceptedHypothesis {
  tier: HeHypothesisTier;
  title: string;
  description: string;
  fit_rationale: string;
  evidence: HeEvidenceItem[];
  potential_pct: number;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Сбой модели, после которого evidence рынка 'us' останавливает прогон, а не
 * отбрасывает кандидата: временный отказ провайдера (класс 'transient' — 5xx,
 * обрыв, непрочитанный ответ) и истёкший срок вызова модели. Отброшенный
 * кандидат — потерянная гипотеза, а повтор джобы продолжает с чекпойнта:
 * вердикты пройденного префикса второй раз не покупаются, заново оплачиваются
 * только поиск этого кандидата (до MAX_QUERIES_PER_CANDIDATE запросов) и его
 * вердикт. Тратит ли остановка попытку джобы — решает
 * HeEvidenceProgressResumeError ниже. Рынок 'ru' такие сбои поглощает
 * поэлементно, как раньше.
 */
function heEvidenceResumableLlmFailure(error: unknown, market: HeMarket): boolean {
  if (market !== 'us') return false;
  return heLlmFailureOf(error)?.kind === 'transient' || isHeLlmTimeout(error);
}

/**
 * Бесплатных продолжений evidence на одну джобу (только market='us', см.
 * HeEvidenceProgressResumeError). Счётчик — free_resumes в чекпойнте этой
 * джобы: он переживает её повторы и обнуляется вместе с чекпойнтом — у новой
 * джобы (новый research) и при новом входе (другой результат hypotheses:
 * чекпойнт с чужим отпечатком отбрасывается целиком, перебор идёт с начала).
 */
const EVIDENCE_FREE_RESUMES_PER_JOB = 5;

/**
 * Остановка evidence рынка 'us' на временном сбое модели
 * (heEvidenceResumableLlmFailure), которая НЕ тратит попытку джобы: это
 * исполнение проверило хотя бы одного кандидата, и чекпойнт с кандидатом, на
 * котором прогон встал, и с увеличенным счётчиком free_resumes перечитан из
 * he_jobs.result (confirmEvidenceFreeResume). Повтор продолжит с этого
 * кандидата. Без этого три разнесённых блипа за прогон съедали три попытки,
 * джоба падала, а «Try again» клиента покупал всё исследование заново.
 *
 * Как воркер узнаёт, что попытка бесплатная. Своей ветки для этого класса у
 * него нет: он читает ДИСКРИМИНАНТ heJobInterruption (isHeJobInterruption в
 * worker/hypothesisEngine.ts) и ведёт ошибку политикой своих прерываний —
 * attempts не растёт, payload.interruptions + 1, повтор не раньше чем через
 * 30 → 60 → 120 с, бесплатно не больше HE_JOB_FREE_INTERRUPTIONS (5) прерываний
 * подряд, дальше обычная попытка. Род kind = 'evidence_progress' виден в его
 * строке лога. Сообщение — исходное сообщение сбоя модели, поэтому he_jobs.error
 * и его разбор кабинетом (clientErrors.ts) те же, что у обычного фейла.
 *
 * Без продвижения (сбой на первом же кандидате исполнения), сверх
 * EVIDENCE_FREE_RESUMES_PER_JOB, когда воркер засчитал бы и это прерывание
 * (бесплатных прерываний подряд у него не осталось, heEvidenceStopFailsJob) или
 * когда чекпойнт не подтвердился, стадия бросает исходный сбой — обычная
 * попытка с паузой провайдера, как раньше. Исключение — последняя попытка
 * джобы (heEvidenceStopFailsJob): засчитанный отказ на ней перевёл бы джобу и
 * проект в failed, и «Try again» купил бы всё исследование заново, поэтому там
 * кандидат отбрасывается с reason='stage_error', как до остановок с
 * чекпойнтом, и перебор продолжается.
 */
class HeEvidenceProgressResumeError extends Error {
  readonly heJobInterruption = true as const;
  readonly kind = 'evidence_progress' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HeEvidenceProgressResumeError';
  }
}

/**
 * Политика попыток воркера, которую evidence рынка 'us' обязано знать, чтобы
 * временный сбой модели не провалил исследование на последней попытке.
 * Зеркала worker/hypothesisEngine.ts: MAX_ATTEMPTS, HE_JOB_FREE_INTERRUPTIONS и
 * счётчик прерываний подряд payload.interruptions (heJobInterruptions); общего
 * модуля у них нет, воркер их отсюда не читает. Расхождение безопасно в одну
 * сторону: дай воркер больше попыток или бесплатных прерываний — evidence лишь
 * раньше отбросит кандидата; меньше — последний сбой снова провалит джобу,
 * поэтому уменьшать числа воркера только вместе с этими.
 */
const HE_JOB_MAX_ATTEMPTS = 3;
const HE_JOB_FREE_INTERRUPTIONS = 5;

/**
 * Чем кончится для джобы остановка на временном сбое модели, если её бросить:
 *  - interruptionCounted — воркер засчитает и прерывание
 *    (HeEvidenceProgressResumeError): бесплатных прерываний подряд у него не
 *    осталось — payload.interruptions уже не меньше HE_JOB_FREE_INTERRUPTIONS;
 *  - lastAttempt — засчитанный отказ станет последним: attempts + 1 ≥
 *    HE_JOB_MAX_ATTEMPTS, воркер переведёт джобу и проект в failed.
 */
function heEvidenceStopFailsJob(job: HeJob): { interruptionCounted: boolean; lastAttempt: boolean } {
  const attempts = Number.isInteger(job.attempts) && job.attempts > 0 ? job.attempts : 0;
  const raw = job.payload?.interruptions;
  const interruptions = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0;
  return {
    interruptionCounted: interruptions + 1 > HE_JOB_FREE_INTERRUPTIONS,
    lastAttempt: attempts + 1 >= HE_JOB_MAX_ATTEMPTS,
  };
}

/** Запросы кандидата без повторов (регистр, пробелы) и пустых, не больше max. */
function uniqueQueries(queries: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const key = normTitle(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Выдача нескольких запросов вперемешку: по кругу по одному результату от
 * каждой дорожки (запроса), ссылка — один раз, не больше limit.
 */
function takeRoundRobin(lanes: HeSearchItem[][], limit: number): HeSearchItem[] {
  const out: HeSearchItem[] = [];
  const seen = new Set<string>();
  const cursors = lanes.map(() => 0);
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let lane = 0; lane < lanes.length && out.length < limit; lane += 1) {
      while (cursors[lane] < lanes[lane].length) {
        const item = lanes[lane][cursors[lane]++];
        if (seen.has(item.link)) continue;
        seen.add(item.link);
        out.push(item);
        progressed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Источники рынка 'us': по одному на запрос. Дорожка запроса читается сверху
 * строгим чтением страницы; ответ без страницы (404, не-HTML, редирект
 * отклонён), почти без текста или сбой чтения — берётся следующий результат
 * той же дорожки, до MAX_SOURCE_TRIES_PER_QUERY, всего не больше
 * MAX_SOURCE_TRIES_PER_CANDIDATE. Ссылка, уже прочитанная для другой дорожки,
 * второй раз не читается. Адрес источника — итоговый, после редиректов: по нему
 * verifyEvidence сверяет source_url.
 */
async function fetchSourcesPerQuery(
  ctx: HeStageContext,
  fetchPage: HeFetchPageFn,
  lanes: HeSearchItem[][],
  jobSignal: AbortSignal | undefined,
): Promise<Array<{ url: string; text: string }>> {
  const sources: Array<{ url: string; text: string }> = [];
  const tried = new Set<string>();
  const taken = new Set<string>();
  let tries = 0;
  for (const lane of lanes) {
    let laneTries = 0;
    for (const item of lane) {
      if (tries >= MAX_SOURCE_TRIES_PER_CANDIDATE || laneTries >= MAX_SOURCE_TRIES_PER_QUERY) break;
      if (tried.has(item.link)) continue;
      tried.add(item.link);
      tries += 1;
      laneTries += 1;
      try {
        const page = await fetchPage(item.link);
        if (page && page.text.trim().length >= MIN_SOURCE_CHARS && !taken.has(page.url)) {
          taken.add(page.url);
          sources.push({ url: page.url, text: truncate(page.text, SOURCE_EXCERPT) });
          break;
        }
        stageLog(
          ctx,
          `[evidence] источник ${item.link} пропущен: `
            + `${page ? 'текста почти нет или та же страница уже взята' : 'страницы по адресу нет'}`,
        );
      } catch (e) {
        if (jobSignal?.aborted) throw e;
        stageLog(ctx, `[evidence] фетч ${item.link} пропущен: ${heIoFailureReason(e)}`);
      }
    }
  }
  return sources;
}

/**
 * Гипотезы проекта, уже размеченные человеком: нормализованный title → статус
 * ('accepted' — рынок выбран, 'rejected' — отклонён). Только market='us'.
 * Сбой чтения роняет стадию до любого платного вызова: без этого списка
 * повтор research мог бы снова предложить отклонённую гипотезу.
 */
async function readReviewedTitles(ctx: HeStageContext, projectId: string): Promise<Map<string, string>> {
  const { data, error } = await ctx.supabase
    .from('he_hypotheses')
    .select('title, status')
    .eq('project_id', projectId)
    .in('status', ['accepted', 'rejected']);
  if (error) throw new Error(`he_hypotheses read reviewed: ${error.message}`);
  const reviewed = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ title?: unknown; status?: unknown }>) {
    if (typeof row.title === 'string' && normTitle(row.title)) reviewed.set(normTitle(row.title), String(row.status));
  }
  return reviewed;
}

/**
 * Чекпойнт перебора кандидатов (только market='us', см. HE_ITEM_CHECKPOINT_KEY
 * в brandCloud.ts): кандидаты [0, next) пройдены — их вердикты (keep/merge/drop)
 * и поэлементные сбои уже учтены в accepted и счётчиках. Кандидат, на котором
 * прогон остановился, в префикс не входит и на повторе спрашивается заново.
 */
const EvidenceCheckpointSchema = z.object({
  stage: z.literal('evidence'),
  v: z.literal(1),
  fingerprint: z.string(),
  next: z.number().int().min(1),
  accepted: z.array(
    z.object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      title: z.string(),
      description: z.string(),
      fit_rationale: z.string(),
      evidence: z.array(HeEvidenceItemSchema),
      potential_pct: z.number(),
    }),
  ),
  merged: z.number().int().min(0),
  dropped: z.number().int().min(0),
  evidence_dropped: z.number().int().min(0),
  search_answered: z.number().int().min(0),
  /** Бесплатных продолжений этой джобы уже взято (EVIDENCE_FREE_RESUMES_PER_JOB). */
  free_resumes: z.number().int().min(0).default(0),
});
type EvidenceCheckpoint = z.infer<typeof EvidenceCheckpointSchema>;

/** Годный чекпойнт этого входа или null (с причиной в логе, если он был). */
function readEvidenceCheckpoint(
  ctx: HeStageContext,
  job: HeJob,
  fingerprint: string,
  total: number,
): EvidenceCheckpoint | null {
  const raw = readHeItemCheckpoint(job);
  if (raw === null) return null;
  const parsed = EvidenceCheckpointSchema.safeParse(raw);
  if (!parsed.success || parsed.data.fingerprint !== fingerprint || parsed.data.next > total) {
    stageLog(ctx, '[evidence] чекпойнт прошлого исполнения не подходит к этому входу — перебор с начала');
    return null;
  }
  return parsed.data;
}

/**
 * Подтвердить бесплатное продолжение (HeEvidenceProgressResumeError): записать
 * чекпойнт с увеличенным счётчиком и перечитать его из he_jobs.result. Запись
 * чекпойнта best-effort и о себе не сообщает; без перечитывания «продвижение»
 * могло остаться только в памяти — повтор начал бы с прошлого чекпойнта и
 * заново купил бы вердикты, а счётчик бесплатных продолжений не вырос бы. null
 * — продолжение подтверждено, иначе причина для лога (попытка тогда тратится).
 */
async function confirmEvidenceFreeResume(
  ctx: HeStageContext,
  job: HeJob,
  checkpoint: EvidenceCheckpoint,
  jobSignal: AbortSignal | undefined,
): Promise<string | null> {
  await writeHeItemCheckpoint(ctx, job, checkpoint, '[evidence]');
  try {
    const { data, error } = await ctx.supabase.from('he_jobs').select('result').eq('id', job.id).maybeSingle();
    if (error) return `чекпойнт не перечитан: ${error.message.slice(0, 160)}`;
    const result = (data as { result?: HeJob['result'] } | null)?.result ?? null;
    const stored = EvidenceCheckpointSchema.safeParse(readHeItemCheckpoint({ ...job, result }));
    if (
      !stored.success
      || stored.data.fingerprint !== checkpoint.fingerprint
      || stored.data.next !== checkpoint.next
      || stored.data.free_resumes !== checkpoint.free_resumes
    ) {
      return 'записанный чекпойнт не совпал с этим исполнением';
    }
    return null;
  } catch (e) {
    if (jobSignal?.aborted) throw e;
    return `чекпойнт не перечитан: ${heIoFailureReason(e)}`;
  }
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

export async function runEvidenceStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<HeSiteProfileOutput>(project);
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  const jobSignal = heStageSignal(ctx);
  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(project);
  // Рынок 'us': дорожки выдачи, источник на запрос, дата в промпте, разметка
  // человека (см. шапку). Дата — одна на исполнение стадии.
  const fetchPage = market === 'us' ? resolveFetchPage(ctx) : null;
  const today = market === 'us' ? heTodayUtc() : '';

  const hypothesesResult = await latestDoneJobResult<{ candidates?: HeHypothesisCandidate[] }>(
    ctx.supabase,
    job.project_id,
    'hypotheses',
  );
  const candidates = hypothesesResult?.candidates ?? [];
  if (!candidates.length) {
    throw new Error('Нет кандидатов: сначала выполните стадию hypotheses');
  }
  const allTitles = candidates.map((c) => c.title);
  const reviewedTitles = market === 'us' ? await readReviewedTitles(ctx, job.project_id) : new Map<string, string>();

  // Та же калибровка, что и на стадии hypotheses, — best-effort: сбой →
  // undefined, верификация продолжается. Грузим один раз на всех кандидатов.
  const [portfolioProfile, markupHistory] = await Promise.all([
    loadPortfolioProfile(ctx, market),
    loadMarkupHistory(ctx, job.project_id, market),
  ]);

  // Чекпойнт перебора — только us: на RU 429 не останавливает перебор, и
  // легаси-инструмент лишних записей в he_jobs не получает. Отпечаток — по
  // кандидатам целиком: другой результат стадии hypotheses — другой вход.
  const resumable = market === 'us';
  const fingerprint = resumable ? heItemCheckpointFingerprint(candidates) : '';
  const restored = resumable ? readEvidenceCheckpoint(ctx, job, fingerprint, candidates.length) : null;
  if (restored) {
    stageLog(
      ctx,
      `[evidence] продолжаем с чекпойнта прошлого исполнения этой джобы: ${restored.next}/${candidates.length} `
        + `кандидатов уже проверено (принято ${restored.accepted.length}), их вердикты повторно не покупаем`,
    );
  }
  const accepted: AcceptedHypothesis[] = restored ? restored.accepted : [];
  let merged = restored?.merged ?? 0;
  let dropped = restored?.dropped ?? 0;
  let evidenceDropped = restored?.evidence_dropped ?? 0;
  // Бесплатные продолжения (us): сколько уже взято этой джобой и сколько
  // кандидатов проверило ЭТО исполнение (HeEvidenceProgressResumeError).
  const freeResumes = restored?.free_resumes ?? 0;
  let settledThisRun = 0;

  /**
   * Вердикт keep/merge кандидата → пост-верификация, якорь, кап и слияние.
   * Вынесено из цикла, чтобы у каждой ветки цикла был один выход — к записи
   * чекпойнта после кандидата (us), — а не `continue` мимо неё.
   */
  const settleVerdict = async (
    candidate: HeHypothesisCandidate,
    v: HeEvidenceVerdict,
    sources: Array<{ url: string; text: string }>,
  ): Promise<void> => {
    // Кодовая пост-верификация: URL обязан быть среди скачанных источников,
    // цитата — подстрокой его текста. Сфабрикованное выкидываем; гипотеза
    // без единого проверенного доказательства капается по % (свои же правила
    // промпта: «нет доказательного пути» → низкий потенциал).
    const check = verifyEvidenceItems(v.evidence, sources);
    if (check.dropped > 0) {
      evidenceDropped += check.dropped;
      stageLog(
        ctx,
        `[evidence] «${candidate.title}»: отброшено ${check.dropped} недоказанных пунктов (URL/цитата не из скачанного)`,
      );
    }
    // Дата-якорь: программный матч сегмента датасета + факт reply% →
    // ограниченная поправка (0.7×LLM + 0.3×datasetScore). Без честного
    // матча/объёма — оценка LLM без изменений (см. scoreAnchor.ts).
    const anchor = await anchorPotentialPct(v.potential_pct, candidate.title, market);
    if (anchor.applied && anchor.pct !== v.potential_pct) {
      stageLog(ctx, `[evidence] «${candidate.title}»: ${v.potential_pct}% → ${anchor.pct}% (${anchor.note})`);
    }
    // Кап «нет проверенных доказательств» — ПОСЛЕ якоря: иначе горячий
    // сегмент датасета поднимал бы неверифицированную гипотезу до ~43%.
    const finalPct = check.valid.length === 0 ? Math.min(anchor.pct, 20) : anchor.pct;

    if (v.verdict === 'merge' && v.merge_with_title) {
      const target = accepted.find((a) => normTitle(a.title) === normTitle(v.merge_with_title as string));
      if (target) {
        target.evidence = [...target.evidence, ...check.valid].slice(0, MAX_EVIDENCE_PER_HYPOTHESIS);
        target.potential_pct = Math.max(target.potential_pct, finalPct);
        merged += 1;
        return;
      }
      // Цель мержа не найдена среди принятых — трактуем как keep.
      stageLog(ctx, `[evidence] merge-цель «${v.merge_with_title}» не найдена, keep`);
    }

    accepted.push({
      tier: candidate.tier,
      title: candidate.title,
      description: candidate.description,
      // Вердикт обязан пронести fit_rationale (возможно, уточнив по фактам);
      // пустое поле — откат к исходной цепочке кандидата.
      fit_rationale: v.fit_rationale || candidate.fit_rationale,
      evidence: check.valid.slice(0, MAX_EVIDENCE_PER_HYPOTHESIS),
      potential_pct: finalPct,
    });
  };

  // Подпись прогресса уезжает в he_jobs.progress.label и печатается клиенту
  // как есть (блок «Right now» кабинета ENG), поэтому зависит от рынка, а не
  // переводится насовсем: тот же V1 обслуживает русский внутренний инструмент.
  const progressLabel = market === 'us' ? 'checking a hypothesis' : 'проверяем гипотезу';
  // Счётчик один на всё исполнение: «тонкие доказательства» из-за пустой выдачи
  // по одному кандидату — норма, а вот НУЛЬ обслуженных запросов за всю стадию
  // означает, что кластеризация ранжировала бы гипотезы по пустоте. Остановка по
  // полному отказу поиска (heSearchOutageFailure) судит по ЭТОМУ исполнению —
  // о том, что поиск делает сейчас; обслуженные запросы префикса из чекпойнта
  // (только us) учитываются лишь в итоговой проверке после цикла.
  // У RU-проекта отказ поиска сюда не доходит: resolveSearch отдаёт ему пустую
  // выдачу, как до порта ENG (io.ts), а остановки по отказу ниже стоят только у
  // 'us' (searchStops).
  const tally = newHeSearchTally();
  const searchStops = market === 'us';
  const restoredSearchAnswered = restored?.search_answered ?? 0;
  let searchedThisRun = 0;

  for (let i = restored?.next ?? 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    await reportProgress(ctx, job.id, i + 1, candidates.length, progressLabel);
    // Повтор research (us): гипотезу, которую человек уже разметил, не проверяем
    // и не вставляем заново (см. шапку). Пропуск бесплатен — ни поиска, ни
    // модели, — поэтому идёт мимо чекпойнта: следующий кандидат запишет next и
    // за этот, а повтор джобы пропустит его так же.
    const reviewed = reviewedTitles.get(normTitle(candidate.title));
    if (reviewed) {
      stageLog(ctx, `[evidence] «${candidate.title}» уже размечена (${reviewed}) — не проверяем и заново не предлагаем`);
      continue;
    }
    stageLog(ctx, `[evidence] «${candidate.title}»…`);

    // 1) Поиск по запросам кандидата (2–4), дедуп ссылок, best-effort.
    const fallbackQuery = market === 'us' ? `${candidate.title} market size` : `${candidate.title} рынок объём`;
    const rawQueries = candidate.search_queries.length ? candidate.search_queries : [fallbackQuery];
    const distinctQueries = fetchPage ? uniqueQueries(rawQueries, MAX_QUERIES_PER_CANDIDATE) : [];
    const queries = fetchPage
      ? (distinctQueries.length ? distinctQueries : [fallbackQuery])
      : rawQueries.slice(0, MAX_QUERIES_PER_CANDIDATE);
    const seenLinks = new Set<string>();
    const searchResults: Array<{ title: string; link: string; snippet?: string }> = [];
    // Рынок 'us': выдача каждого запроса — своя дорожка (см. шапку).
    const lanes: HeSearchItem[][] = [];
    for (const q of queries) {
      try {
        const items = await search(q);
        noteHeSearchAnswered(tally);
        if (fetchPage) {
          lanes.push(items);
          continue;
        }
        for (const item of items) {
          if (seenLinks.has(item.link) || searchResults.length >= MAX_SEARCH_ITEMS) continue;
          seenLinks.add(item.link);
          searchResults.push(item);
        }
      } catch (e) {
        if (jobSignal?.aborted) throw e;
        noteHeSearchFailure(tally, e);
        stageLog(ctx, `[evidence] поиск «${q}» упал: ${heIoFailureReason(e)}`);
        if (fetchPage) lanes.push([]);
      }
    }
    if (fetchPage) searchResults.push(...takeRoundRobin(lanes, MAX_SEARCH_ITEMS));
    // Ниже на КАЖДОГО кандидата идёт платный вызов ресёрч-модели, и его вход —
    // ровно то, что нашёл поиск. Останавливаемся до вызова и ДО перезаписи
    // he_hypotheses (прошлые предложенные гипотезы проекта должны уцелеть) в
    // двух случаях: отказ по деньгам/ключу сам не пройдёт, а поиск, не
    // обслуживший НИ ОДНОГО запроса за два кандидата подряд, лёг целиком —
    // остальным кандидатам достанется тот же пустой массив источников
    // (heSearchOutageFailure). Одна пустая выдача, один упавший кандидат и
    // одиночный блип сюда не попадают: первая считается обслуженной, вторые два
    // не переживают следующего кандидата.
    searchedThisRun += 1;
    const outage = searchStops ? heSearchOutageFailure(tally, searchedThisRun) : undefined;
    if (outage) {
      stageLog(
        ctx,
        `[evidence] поиск отказал (обслужено запросов: ${tally.answered}) — `
          + `стадия остановлена на «${candidate.title}» (${i}/${candidates.length}), `
          + `до платного вызова модели: ${heIoFailureReason(outage)}${heSearchFailureStatus(outage)}`,
      );
      throw outage;
    }

    // 2) Фетч топ-1–2 источников; сбойные пропускаем. Рынок 'us' — по
    //    источнику на запрос со сдвигом на следующий результат (см. шапку).
    const sources: Array<{ url: string; text: string }> = fetchPage
      ? await fetchSourcesPerQuery(ctx, fetchPage, lanes, jobSignal)
      : [];
    for (const item of fetchPage ? [] : searchResults.slice(0, MAX_SOURCES_TO_FETCH)) {
      try {
        sources.push({ url: item.link, text: truncate(await fetchText(item.link), SOURCE_EXCERPT) });
      } catch (e) {
        if (jobSignal?.aborted) throw e;
        // Причину печатаем: истёкший срок и «источник не отдался» — разные
        // исходы, а раньше в логе не было ни того, ни другого.
        stageLog(ctx, `[evidence] фетч ${item.link} пропущен: ${heIoFailureReason(e)}`);
      }
    }

    // 3) LLM-вердикт. Сбой по одному кандидату → drop с reason='stage_error'.
    try {
      // Переменная, а не литерал (см. hypotheses.ts): промпт-контракт с полями
      // portfolioProfile / markupHistory приземляется параллельно.
      const verdictInput = {
        candidate,
        profile,
        allCandidateTitles: allTitles,
        sources,
        searchResults,
        ...(portfolioProfile ? { portfolioProfile } : {}),
        ...(markupHistory ? { markupHistory } : {}),
        ...(today ? { today } : {}),
      };
      const llm = await callLLMWithSchema(
        (market === 'us' ? buildEvidenceMessagesEn : buildEvidenceMessages)(verdictInput),
        HeEvidenceVerdictSchema,
        { model: getHeModel('research'), maxTokens: 4096 },
      );
      addUsage(usage, llm);
      const v = llm.data;

      if (v.verdict === 'drop') {
        dropped += 1;
        stageLog(ctx, `[evidence] drop: ${v.reason}`);
      } else {
        await settleVerdict(candidate, v, sources);
      }
    } catch (e) {
      // Отмена задачи — не «кандидат отброшен»: прерываем стадию, иначе цифра
      // dropped соврёт, а перебор продолжит тратить деньги после отмены.
      if (jobSignal?.aborted) throw e;
      // Отказ ДОСТУПА к модели (деньги, ключ; на us ещё и лимит частоты) — тоже
      // не «кандидат отброшен»: остальные кандидаты получат тот же ответ,
      // dropped соврёт на все оставшиеся, а перезапись he_hypotheses ниже
      // заменила бы хороший набор гипотез проекта пустым. Проглоченный здесь,
      // этот класс не доходил до джобы — а пауза по 429 и терминальный отказ по
      // 402/401 живут именно там. Бросаем исходную ошибку: воркеру нужен её тип
      // целым. Чекпойнт (us) при этом остаётся на предыдущем кандидате: этот в
      // префикс не попал и на повторе будет спрошен заново. У RU-проекта ни один
      // отказ модели сюда не попадает и поглощается ниже как stage_error, как
      // до порта ENG (heRunStoppingLlmFailure).
      const refusal = heRunStoppingLlmFailure(e, market);
      if (refusal) {
        stageLog(
          ctx,
          `[evidence] провайдер модели отказал (${heLlmRefusalLabel(refusal)}) — стадия остановлена `
            + `на «${candidate.title}» (${i}/${candidates.length}), до записи в he_hypotheses: `
            + `${heIoFailureReason(e)}`,
        );
        throw e;
      }
      // Временный сбой модели и истёкший срок её вызова на рынке 'us' — тоже не
      // «кандидат отброшен»: прогон останавливается, чекпойнт стоит на
      // предыдущем кандидате, и повтор джобы спросит этот заново
      // (heEvidenceResumableLlmFailure). Попытку джобы остановка не тратит,
      // если это исполнение продвинуло чекпойнт (HeEvidenceProgressResumeError).
      // Засчитанная остановка на последней попытке провалила бы джобу — там
      // кандидат отбрасывается ниже, как раньше (heEvidenceStopFailsJob).
      const modelBlip = heEvidenceResumableLlmFailure(e, market);
      if (modelBlip) {
        const where = `«${candidate.title}» (${i}/${candidates.length})`;
        const stop = heEvidenceStopFailsJob(job);
        let counted: string | null = null;
        if (settledThisRun === 0) counted = 'это исполнение не проверило ни одного кандидата';
        else if (freeResumes >= EVIDENCE_FREE_RESUMES_PER_JOB) {
          counted = `бесплатные продолжения джобы исчерпаны (${freeResumes}/${EVIDENCE_FREE_RESUMES_PER_JOB})`;
        } else if (stop.interruptionCounted) {
          counted = `бесплатных прерываний подряд у воркера не осталось (${HE_JOB_FREE_INTERRUPTIONS})`;
        } else {
          counted = await confirmEvidenceFreeResume(
            ctx,
            job,
            {
              stage: 'evidence',
              v: 1,
              fingerprint,
              next: i,
              accepted,
              merged,
              dropped,
              evidence_dropped: evidenceDropped,
              search_answered: restoredSearchAnswered + tally.answered,
              free_resumes: freeResumes + 1,
            },
            jobSignal,
          );
        }
        if (counted === null) {
          stageLog(
            ctx,
            `[evidence] модель временно не ответила — стадия остановлена на ${where}; это исполнение проверило `
              + `кандидатов: ${settledThisRun}, чекпойнт подтверждён — попытка джобы не тратится (бесплатное `
              + `продолжение ${freeResumes + 1}/${EVIDENCE_FREE_RESUMES_PER_JOB}), повтор продолжит с этого `
              + `кандидата: ${heIoFailureReason(e)}`,
          );
          throw new HeEvidenceProgressResumeError(e instanceof Error ? e.message : String(e));
        }
        if (!stop.lastAttempt) {
          stageLog(
            ctx,
            `[evidence] модель временно не ответила — стадия остановлена на ${where}, попытка джобы тратится `
              + `(${counted}); повтор продолжит с последнего записанного чекпойнта: ${heIoFailureReason(e)}`,
          );
          throw e;
        }
      }
      dropped += 1;
      stageLog(
        ctx,
        `[evidence] stage_error по «${candidate.title}»: ${heIoFailureReason(e)}`
          + (modelBlip
            ? ' (последняя попытка джобы — кандидат отброшен, как до остановок с чекпойнтом, '
              + 'перебор идёт дальше: засчитанная остановка провалила бы исследование)'
            : ''),
      );
    }
    if (resumable) {
      settledThisRun += 1;
      await writeHeItemCheckpoint(
        ctx,
        job,
        {
          stage: 'evidence',
          v: 1,
          fingerprint,
          next: i + 1,
          accepted,
          merged,
          dropped,
          evidence_dropped: evidenceDropped,
          search_answered: restoredSearchAnswered + tally.answered,
          free_resumes: freeResumes,
        },
        '[evidence]',
      );
    }
  }

  // Отказ поиска на ВСЕХ запросах (или перманентный отказ где угодно):
  // доказательств не искали, а не «не нашли». Падаем до удаления прошлых
  // предложенных гипотез — иначе проект остался бы и без старых, и без новых.
  const searchFailure = searchStops
    ? heSearchStageFailure({ ...tally, answered: tally.answered + restoredSearchAnswered })
    : undefined;
  if (searchFailure) {
    stageLog(
      ctx,
      `[evidence] поиск не обслужил ни одного запроса по ${candidates.length} кандидатам `
        + `(обслужено: ${tally.answered}) — стадия остановлена до записи: `
        + `${heIoFailureReason(searchFailure)}${heSearchFailureStatus(searchFailure)}`,
    );
    throw searchFailure;
  }

  // 4) Идемпотентная перезапись: сносим прошлые предложенные (ещё не
  //    кластеризованные) гипотезы проекта, вставляем свежие. Рынок 'us' сносит
  //    ВСЕ прошлые 'proposed' проекта, и привязанные к вертикалям прошлого
  //    прогона тоже: кластеризация этого прогона их вертикали всё равно
  //    удаляет, а оставленные копились бы дублями рядом с новыми. Размеченные
  //    человеком (accepted/rejected) не трогает ни один рынок.
  //
  //    Снос у 'us' — ТОЛЬКО если этому прогону есть чем заменить. Пустой
  //    accepted — это либо «модель забраковала всех кандидатов», либо «прогон
  //    не смог их проверить», и различить их здесь нечем; а снос в обоих случаях
  //    оставлял проект БЕЗ гипотез: хороший набор прошлой ночи молча заменялся
  //    ничем, и кабинет показывал завершившееся исследование с пустым списком.
  //    Идемпотентность от этого не страдает: дубли создаёт только вставка, а
  //    она в этой ветке не выполняется. RU-проект сносит прошлые
  //    некластеризованные 'proposed' всегда, а вставляет только принятые, как
  //    до порта ENG (решение владельца 14.10.2026 «Как было»).
  const keepPriorProposed = market === 'us' && !accepted.length;
  if (!keepPriorProposed) {
    const { error: delError } = market === 'us'
      ? await ctx.supabase
        .from('he_hypotheses')
        .delete()
        .eq('project_id', job.project_id)
        .eq('status', 'proposed')
      : await ctx.supabase
        .from('he_hypotheses')
        .delete()
        .eq('project_id', job.project_id)
        .is('vertical_id', null)
        .eq('status', 'proposed');
    if (delError) throw new Error(`he_hypotheses cleanup: ${delError.message}`);
  }

  if (accepted.length) {
    const rows = accepted.map((a) => ({
      project_id: job.project_id,
      tier: a.tier,
      title: a.title,
      description: a.description,
      fit_rationale: a.fit_rationale,
      evidence: a.evidence,
      potential_pct: a.potential_pct,
      status: 'proposed',
    }));
    // Строки — текст модели (заголовок, описание, обоснование, цитаты): один NUL
    // или одиночный UTF-16 суррогат, и PostgREST отвергает ВСЮ вставку — после
    // уже оплаченных вердиктов по всем кандидатам и уже сделанного сноса прошлых
    // 'proposed'. Чистка трогает только эти два символа: текст без них (вся
    // кириллица и латиница) ложится байт-в-байт тем же. Только market='us':
    // RU-проект пишет строки как до порта ENG (решение владельца 14.10.2026
    // «Как было»; так же chain, template, vocab, clustering и base_analyze).
    const { error: insError } = await ctx.supabase
      .from('he_hypotheses')
      .insert(market === 'us' ? stripUnstorableJsonChars(rows) : rows);
    if (insError) throw new Error(`he_hypotheses insert: ${insError.message}`);
  } else if (keepPriorProposed) {
    // Молчать нельзя: снаружи (и в кабинете) прогон выглядит завершившимся, а
    // гипотезы в нём — прошлой ночи. Флаг дублируется в result, чтобы это
    // читалось из he_jobs.result, а не только из лога прогона.
    stageLog(
      ctx,
      `[evidence] принятых гипотез нет (кандидатов ${candidates.length}, отброшено ${dropped}) — `
        + 'прошлые предложенные гипотезы проекта ОСТАВЛЕНЫ как есть',
    );
  }

  const result = {
    total_candidates: candidates.length,
    kept: accepted.length,
    merged,
    dropped,
    evidence_dropped: evidenceDropped,
    ...(keepPriorProposed ? { prior_proposed_kept: true } : {}),
  };
  stageLog(ctx, `[evidence] итог: ${JSON.stringify(result)}`);
  return { result, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
