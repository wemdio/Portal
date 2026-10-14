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
 * Отказ ДОСТУПА к провайдеру (поиск: деньги/ключ; модель: деньги/ключ, а на
 * рынке us ещё и лимит частоты) прерывает перебор так же, как отмена: он
 * перманентен для прогона, а успешная стадия с пустым списком сущностей
 * читается стадией hypotheses как «следов бренда нет» — вывод о рынке вместо
 * честного отказа. Так же прерывает перебор и ПОЛНЫЙ отказ поиска (ни одного
 * обслуженного бренда за два подряд): платить вызовом модели за каждый
 * следующий бренд не за что (heSearchOutageFailure). Сбой ОДНОГО бренда
 * (мёртвый сайт, пустая выдача, 4xx на его же контексте) по-прежнему
 * пропускается — см. heRunStoppingLlmFailure ниже.
 *
 * Все три остановки — отказ доступа к провайдеру, полный отказ поиска и «модель
 * не разобрала ни один бренд» — ТОЛЬКО market='us' (решение владельца
 * 14.10.2026 «Как было»). RU-проект перебирает бренды, как до порта ENG: сбой
 * по бренду пропускается, стадия завершается со списком сущностей, какой
 * получился (в том числе пустым).
 *
 * Чекпойнт перебора (только market='us'): после каждого бренда, как только
 * хоть один бренд разобран, разобранный префикс пишется в he_jobs.result этой
 * же джобы, и повтор джобы продолжает с него — оплаченные ответы модели второй
 * раз не покупаются (HE_ITEM_CHECKPOINT_KEY ниже).
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';

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
import { heStageSignal, resolveFetchPage, resolveFetchText, resolveSearch } from './io';
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
// Клиент для записи чекпойнта перебора — без сигнала джобы (см.
// HE_ITEM_CHECKPOINT_KEY ниже).
import { heCheckpointSupabase } from '../stageDb';
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
 *  - billing / configuration (только market='us'): нужен человек. Воркер
 *    отказывает по ним терминально (failJob, terminalProviderRefusal) — то
 *    есть НЕ переплачивает стадию двумя лишними прогонами;
 *  - rate_limit — ТОЛЬКО market='us' (см. heRunStoppingLlmFailure). Транспорт
 *    уже пересидел 429 внутри вызова (до 3 повторов, каждое ожидание ≤30 с) и
 *    всё равно получил отказ. Воркер отодвигает повтор до времени, которое
 *    назвал провайдер (failJob → rateLimitPauseMs, run_after, потолок паузы
 *    10 минут), и тратит на это попытку. Повтор начинает стадию заново, но
 *    НЕ с первого элемента: перебор на us пишет чекпойнт после каждого
 *    элемента (HE_ITEM_CHECKPOINT_KEY), и уже полученные ответы модели
 *    берутся из него. Худший случай стойкого 429 на последнем элементе —
 *    каждый полученный ответ (вердикт, разбор бренда) оплачен один раз, а не
 *    MAX_ATTEMPTS раз; заново спрашивается только элемент, на котором прогон
 *    встал (сам 429 не оплачивается).
 *
 * На русском рынке (легаси /tools/hypothesis-engine, ежедневный инструмент
 * специалистов) ЛЮБОЙ отказ модели — 429, деньги, ключ — поглощается
 * поэлементно, как было до порта ENG (решение владельца 14.10.2026 «Как
 * было»): элемент пропускается, перебор идёт дальше, стадия кончается за одно
 * исполнение.
 * Волна 3 сделала 429 останавливающим и для RU, не сказав об этом, и воркер
 * перезапускал стадию с первого элемента, заново покупая уже готовые вердикты
 * (до трёх исполнений там, где база платила один раз). Чекпойнта у RU нет —
 * лишних записей в he_jobs легаси-инструмент не получает.
 *
 * Absorbed на обоих рынках: 'transient' (5xx, обрыв, битый конверт — соседний
 * элемент честно может ответить) и 'permanent' (прочие 4xx: это про ЭТОТ
 * запрос — слишком длинный контекст одного бренда, отказ фильтра содержимого).
 * Схемные сбои (LLMValidationError) и усечения тоже остаются поэлементными:
 * они про ответ модели, а не про доступ к ней.
 *
 * Одно исключение — evidence на market='us' (heEvidenceResumableLlmFailure в
 * stages/evidence.ts): там 'transient' и истёкший срок вызова модели прогон
 * тоже останавливают. Пропущенный brand_cloud'ом бренд — один из шести входов
 * гипотез, а пропущенный кандидат evidence — потерянная гипотеза, которую
 * повтор джобы с чекпойнта переспрашивает, не покупая вердикты префикса.
 */
const HE_RUN_STOPPING_LLM_KINDS = new Set<HeLlmFailureKind>(['billing', 'configuration']);

/**
 * Факты отказа модели, если он останавливает весь прогон, — иначе null.
 * Читается ТИПОМ (heLlmFailureOf → дискриминант класса транспорта), никогда
 * регэкспом по тексту: в этом движке «aborted» означает отмену пользователем.
 * Только market='us' — там повтор продолжает с чекпойнта (см. docblock
 * HE_RUN_STOPPING_LLM_KINDS); у RU-проекта всегда null, как до порта ENG.
 */
export function heRunStoppingLlmFailure(error: unknown, market: HeMarket): HeLlmFailureFacts | null {
  if (market !== 'us') return null;
  const failure = heLlmFailureOf(error);
  if (!failure) return null;
  if (HE_RUN_STOPPING_LLM_KINDS.has(failure.kind)) return failure;
  return failure.kind === 'rate_limit' ? failure : null;
}

/**
 * ЧЕКПОЙНТ ПОЭЛЕМЕНТНОГО ПЕРЕБОРА (brand_cloud и evidence, только market='us').
 *
 * Где лежит и почему там. В he_jobs.result СВОЕЙ ЖЕ строки джобы, под одним
 * ключом. Пока джоба не 'done', колонку не читает никто: latestDoneJobResult
 * фильтрует status='done', списки джоб кабинета и staff-инструмента result не
 * выбирают (HE_JOB_LIST_COLUMNS, HE_JOB_CLIENT_COLUMNS, дашборд ENG). Запись
 * отказа воркера (failJob) result не трогает, клейм читает строку целиком
 * (`select('*')`), поэтому повтор той же джобы получает чекпойнт в job.result.
 * Done-запись воркера заменяет result целиком — после успеха чекпойнта нет.
 * Новая джоба (следующая ночь, перезапуск исследования) — новая строка с
 * пустым result: чужой чекпойнт она не увидит никогда. payload для этого не
 * годится: failJob при прерывании переписывает его из копии, снятой ДО стадии.
 *
 * Чем пишется. После каждого элемента — клиентом ЧЕКПОЙНТА ОПЛАТЫ
 * (stageDb.heCheckpointSupabase), с откатом на клиент стадий, когда его нет (url
 * или сервисный ключ не в окружении). Выбор клиента тот же, что у записей из
 * списка paidCheckpointDb (stages/baseCollect.ts; модуль сборки ради одной
 * строки сюда не тянем), и по тому же критерию: запись фиксирует ответы модели,
 * за которые уже заплачено, — это деньги, а не работа. Сроки на заголовки и на
 * паузу в теле у клиента те же (HE_STAGE_DB_TIMEOUT_MS), сигнала джобы нет.
 *
 * Что это меняет — по каждому, кто гасит сигнал джобы:
 *  - отмена: запись, которую отмена застала в полёте, клиент стадий обрывал, а
 *    этот доводит до конца (не дольше её срока). Барьер `status='running'`
 *    отвергает её так же, как отверг бы и раньше: отменённую строку никто не
 *    продолжает;
 *  - сторож простоя: при умолчаниях до этой записи он не дотягивается. Его
 *    окно (не меньше 1 200 000 мс, по умолчанию 1 800 000) считается от
 *    отметки прямо перед записью — ответа модели (транспорт отмечает приход
 *    ответа) или строки лога, — а запись кончается за HE_STAGE_DB_TIMEOUT_MS
 *    (120 000 мс). Дотянуться он может, только если этот срок поднят до
 *    порядка окна сторожа; тогда abort запись не обрывает, у неё есть
 *    STAGE_ABORT_GRACE_MS (120 000 мс) до выхода процесса, и повтор продолжает
 *    ПОСЛЕ этого элемента, а не перед ним. То есть это гарантия по построению,
 *    а не лечение наблюдённой потери.
 * Отметки живости сторожу запись не даёт (прокси активности воркера навешен на
 * клиент стадий) — простоя из этого не выходит по той же арифметике.
 *
 * Запись best-effort: отказ значит лишь, что чекпойнт отстал, а следующая
 * запись кумулятивна и догонит его. Худший случай — записи не дошли подряд
 * прямо перед остановкой прогона (ошибка PostgREST, собственный срок записи,
 * выход процесса по окну сторожа): повтор заново купит ответы ровно этих
 * элементов (обычно одного). Сам вызов, на котором прогон остановился (429,
 * отмена, сторож), в префикс не входит никогда.
 *
 * Чего в нём НЕТ — расхода. Каждое исполнение отдаёт воркеру только свой
 * расход, а расход исполнения, которое бросило, воркер записывает сам: каждый
 * оплаченный ответ модели приходит ему по каналу активной джобы (llm.ts,
 * onSpend), и сумму упавшего прогона он пишет до решения о судьбе джобы.
 * Перенос расхода префикса сюда задвоил бы cost_usd — его уже записал воркер
 * по итогам того исполнения, которое этот префикс оплатило.
 *
 * Отпечаток входа. Чекпойнт годен, только пока вход перебора тот же: другой
 * список кандидатов или брендов (перезапуск предыдущей стадии) — и чекпойнт
 * отбрасывается с отдельной строкой в логе, перебор идёт с начала.
 */
const HE_ITEM_CHECKPOINT_KEY = 'he_item_checkpoint';

/** Отпечаток входа перебора для чекпойнта: тот же вход — тот же отпечаток. */
export function heItemCheckpointFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

/** Сырой чекпойнт из job.result (null — его нет). Разбор формы — у стадии. */
export function readHeItemCheckpoint(job: HeJob): unknown {
  const value = job.result?.[HE_ITEM_CHECKPOINT_KEY];
  return value === undefined ? null : value;
}

/**
 * Записать чекпойнт перебора в he_jobs.result своей строки. Никогда не бросает.
 * Клиент — чекпойнта оплаты, без сигнала джобы (см. HE_ITEM_CHECKPOINT_KEY);
 * барьер по 'running' не пускает запись в отменённую или уже закрытую строку.
 */
export async function writeHeItemCheckpoint(
  ctx: HeStageContext,
  job: HeJob,
  checkpoint: Record<string, unknown>,
  logTag: string,
): Promise<void> {
  try {
    const { error } = await (heCheckpointSupabase() ?? ctx.supabase)
      .from('he_jobs')
      // Текст модели внутри (цитаты, обоснования): NUL и одиночный суррогат
      // PostgREST отверг бы вместе со всей записью.
      .update({ result: { [HE_ITEM_CHECKPOINT_KEY]: stripUnstorableJsonChars(checkpoint) } })
      .eq('id', job.id)
      .eq('status', 'running');
    if (error) stageLog(ctx, `${logTag} чекпойнт перебора не записан: ${error.message.slice(0, 160)}`);
  } catch (e) {
    stageLog(ctx, `${logTag} чекпойнт перебора не записан: ${heIoFailureReason(e)}`);
  }
}

const BrandCloudCheckpointSchema = z.object({
  stage: z.literal('brand_cloud'),
  v: z.literal(1),
  fingerprint: z.string(),
  next: z.number().int().min(1),
  answered: z.number().int().min(1),
  search_answered: z.number().int().min(0),
  entities: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      classification: z.enum(['anomaly', 'noise', 'potential']),
      potential_pct: z.number(),
      rationale: z.string(),
      source_brand: z.string(),
    }),
  ),
});
type BrandCloudCheckpoint = z.infer<typeof BrandCloudCheckpointSchema>;

/** Годный чекпойнт этого входа или null (с причиной в логе, если он был). */
function readBrandCloudCheckpoint(
  ctx: HeStageContext,
  job: HeJob,
  fingerprint: string,
  total: number,
): BrandCloudCheckpoint | null {
  const raw = readHeItemCheckpoint(job);
  if (raw === null) return null;
  const parsed = BrandCloudCheckpointSchema.safeParse(raw);
  if (!parsed.success || parsed.data.fingerprint !== fingerprint || parsed.data.next > total) {
    stageLog(ctx, '[brand_cloud] чекпойнт прошлого исполнения не подходит к этому входу — перебор с начала');
    return null;
  }
  return parsed.data;
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
  // Кейс-страница рынка 'us' — строгим чтением (io.ts resolveFetchPage): её
  // адрес взят из выдачи, и 404 или PDF по нему — «страницы нет», а не главная
  // или «о компании» того же сайта под чужим адресом. Главная бренда — прежним
  // fetchText: для неё цепочка запасных адресов верна.
  const fetchPage = market === 'us' ? resolveFetchPage(ctx) : null;
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
      if (fetchPage) {
        const page = await fetchPage(caseLink);
        if (page?.text.trim()) pages.push({ url: page.url, text: truncate(page.text, CASE_PAGE_EXCERPT) });
        else stageLog(ctx, `[brand_cloud] кейс-страница ${caseLink} пропущена: страницы по адресу нет`);
      } else {
        pages.push({ url: caseLink, text: truncate(await fetchText(caseLink), CASE_PAGE_EXCERPT) });
      }
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
  // Чекпойнт перебора — только us (см. HE_ITEM_CHECKPOINT_KEY): на RU 429 не
  // останавливает перебор, и легаси-инструмент лишних записей в he_jobs не
  // получает.
  const resumable = market === 'us';
  const fingerprint = resumable ? heItemCheckpointFingerprint(targets) : '';
  const restored = resumable ? readBrandCloudCheckpoint(ctx, job, fingerprint, targets.length) : null;
  if (restored) {
    stageLog(
      ctx,
      `[brand_cloud] продолжаем с чекпойнта прошлого исполнения этой джобы: ${restored.next}/${targets.length} `
        + `брендов уже пройдено (разобрано ${restored.answered}), их ответы модели повторно не покупаем`,
    );
  }
  const entities: BrandCloudEntity[] = restored ? restored.entities : [];
  // Подпись прогресса уезжает в he_jobs.progress.label и печатается клиенту
  // как есть (блок «Right now» кабинета ENG), поэтому зависит от рынка, а не
  // переводится насовсем: тот же V1 обслуживает русский внутренний инструмент.
  const progressLabel = market === 'us' ? 'mapping a brand' : 'разбираем бренд';
  // Счётчик поиска — ЭТОГО исполнения: остановка по полному отказу поиска
  // (heSearchOutageFailure) судит о том, что поиск делает сейчас, а не о
  // префиксе из чекпойнта. Обслуженные запросы префикса учитываются только в
  // итоговой проверке «ни один бренд не получил выдачи» ниже.
  // У RU-проекта отказ поиска сюда не доходит: resolveSearch отдаёт ему пустую
  // выдачу, как до порта ENG (io.ts), а остановки по отказу ниже стоят только у
  // 'us' (searchStops).
  const tally = newHeSearchTally();
  const searchStops = market === 'us';
  const restoredSearchAnswered = restored?.search_answered ?? 0;
  let searchedThisRun = 0;
  /**
   * Сколько брендов модель РАЗОБРАЛА (ответ прошёл схему) и первый проглоченный
   * сбой. Зачем: пустой список сущностей — утверждение «следов бренда нет», его
   * читает стадия hypotheses. Утверждать это можно по разобранным брендам, а не
   * по нулю ответов: ноль ответов — отсутствие факта, ровно как ноль обслуженных
   * запросов у поиска (heSearchStageFailure).
   */
  let brandsAnswered = restored?.answered ?? 0;
  let firstModelFailure: unknown;
  for (let i = restored?.next ?? 0; i < targets.length; i += 1) {
    const target = targets[i];
    await reportProgress(ctx, job.id, i + 1, targets.length, progressLabel);
    stageLog(ctx, `[brand_cloud] ${target.name}…`);
    const { pages, searchResults } = await collectBrandPages(target, ctx, market, tally);
    searchedThisRun += 1;
    // Ниже — платный вызов модели на КАЖДЫЙ бренд, и половина его входа приходит
    // из поиска. Останавливаемся до вызова, пока перебор не сжёг бюджет модели
    // на пустом входе: отказ по деньгам/ключу сам не пройдёт, а поиск, не
    // обслуживший НИ ОДНОГО бренда за два подряд, лёг целиком
    // (heSearchOutageFailure). Пустая выдача по бренду — факт о бренде, и сюда
    // не попадает; одиночный блип не переживает следующего бренда.
    const outage = searchStops ? heSearchOutageFailure(tally, searchedThisRun) : undefined;
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
      // Отказ ДОСТУПА к модели (деньги, ключ; на us ещё и лимит частоты) — тоже
      // не сбой одного бренда: следующий бренд получит тот же ответ. Раньше его
      // проглатывал этот catch, и класс, который транспорт выделил специально
      // для решения ДЖОБЫ, до неё не доходил: brand_cloud заканчивался УСПЕХОМ
      // с пустым списком сущностей, а стадия hypotheses читает это как «следов
      // бренда нет» — то есть отказ провайдера превращался в вывод о рынке.
      // Бросаем исходную ошибку: её тип нужен воркеру целым (пауза по 429,
      // терминальный отказ по 402/401). У RU-проекта ни один отказ модели сюда
      // не попадает и поглощается ниже как сбой одного бренда, как до порта ENG
      // (см. heRunStoppingLlmFailure).
      const refusal = heRunStoppingLlmFailure(e, market);
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
    // Чекпойнт пишется, только когда в префиксе есть хоть один РАЗОБРАННЫЙ
    // бренд. Префикс из одних сбоев хранить незачем (оплаченного ответа в нём
    // нет), а вреден он прямо: при нуле разобранных стадия ниже бросает, и
    // повтор, начатый с конца такого префикса, бросил бы снова, не попробовав
    // ни одного бренда.
    if (resumable && brandsAnswered > 0) {
      await writeHeItemCheckpoint(
        ctx,
        job,
        {
          stage: 'brand_cloud',
          v: 1,
          fingerprint,
          next: i + 1,
          answered: brandsAnswered,
          search_answered: restoredSearchAnswered + tally.answered,
          entities,
        },
        '[brand_cloud]',
      );
    }
  }

  // Ни один бренд не получил выдачи из-за провайдера: «следов бренда нет» было
  // бы ложью про все бренды сразу, а её читает стадия hypotheses. Обслуженные
  // запросы префикса из чекпойнта (только us) — в том же счёте.
  const searchFailure = searchStops
    ? heSearchStageFailure({ ...tally, answered: tally.answered + restoredSearchAnswered })
    : undefined;
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
  // тот, на котором прогон реально начал сыпаться. Только market='us': RU-проект
  // завершает стадию с пустым списком, как до порта ENG (шапка файла).
  if (market === 'us' && brandsAnswered === 0 && firstModelFailure !== undefined) {
    stageLog(
      ctx,
      `[brand_cloud] модель не разобрала ни один из ${targets.length} брендов — стадия остановлена `
        + `(пустой список сущностей читался бы как «следов бренда нет»): ${heIoFailureReason(firstModelFailure)}`,
    );
    throw firstModelFailure;
  }

  return { result: { entities }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
