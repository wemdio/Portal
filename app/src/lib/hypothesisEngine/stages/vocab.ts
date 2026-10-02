/**
 * Стадия vocab: вертикаль → LLM-матрица вокабуляра (типы компаний ×
 * должности с разметкой buyer/campaign_target × поисковые запросы) +
 * best-effort Serper-верификация топовых терминов и запросов к
 * реестрам/каталогам (термин/запрос без единого результата помечается
 * в notes). Пишется в he_vocab.
 *
 * Локализация: при market='us' LLM-вызов идёт EN-промптом
 * (prompts/vocab.en.ts) — типы компаний/должности/запросы под ENG-источники.
 */

import { z } from 'zod';

import {
  callLLMWithSchema,
  getHeModel,
  LLMValidationError,
  llmValidationIssuePaths,
  type LLMMessage,
} from '../llm';
import { projectMarket } from '../market';
import { HeVocabSchema } from '../schemas';
import { buildVocabMessages } from '../prompts/vocab';
import { buildVocabMessagesEn } from '../prompts/vocab.en';
import { companyPartOfSummaryEn } from '../relevanceGate';
import type { HeHypothesis, HeJob, HeVertical } from '../types';
import { selectPromptHypotheses } from './chain';
import { heStageSignal, resolveSearch } from './io';
import { newHeSearchTally, noteHeSearchAnswered, noteHeSearchFailure } from './searchIo';
import { heIoFailureReason } from '../operationDeadline';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

const TERMS_TO_VERIFY = 3;
const REGISTRY_QUERIES_TO_VERIFY = 2;

/** Поля вокабуляра, пустота которых = бесполезный вокабуляр (порог в HeVocabSchema). */
const REQUIRED_VOCAB_FIELDS = ['company_types', 'job_titles'] as const;
type RequiredVocabField = (typeof REQUIRED_VOCAB_FIELDS)[number];

/** Потолок ответа модели вокабуляра; он же назван в тексте отказа про усечение. */
const VOCAB_MAX_TOKENS = 8192;

/**
 * Пустой элемент списка (`term`/`title` — пустая строка или одни пробелы)
 * выбрасываем ДО схемы, а не отвергаем им весь ответ.
 *
 * Схема (HeVocabSchema) держит `.trim().min(1)` на `term`/`title`, и один
 * пустой элемент среди сорока валидных отвергал ВЕСЬ оплаченный словарь. Путь
 * такой ошибки — «company_types.N.term», то есть это не «словарь пуст», и она
 * шла обычным схемным сбоем: два вызова на исполнение × MAX_ATTEMPTS = шесть
 * оплаченных bulk-вызовов и упавший вокабуляр там, где до волны 3 ответ
 * принимался с первого вызова (и на ежедневном RU-инструменте тоже). Пустой
 * термин или должность не несут ни одному потребителю ничего, поэтому такой
 * элемент просто не попадает в he_vocab (до волны 3 он сохранялся пустой
 * строкой). Список, в котором НЕ осталось ни одного элемента, после этого
 * упирается в `.min(1)` и честно читается как пустой (HeVocabEmptyError).
 *
 * Элемент с полем НЕ строкой (нет `term`, число, null) не трогаем: это формат
 * ответа, и ему положены штатные повторы схемного сбоя.
 */
function dropBlankVocabEntries(value: unknown, onDropped: (count: number) => void): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const answer = value as Record<string, unknown>;
  let dropped = 0;
  const withoutBlank = (list: unknown, field: 'term' | 'title'): unknown => {
    if (!Array.isArray(list)) return list;
    return list.filter((item) => {
      const text = item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined;
      const blank = typeof text === 'string' && text.trim() === '';
      if (blank) dropped += 1;
      return !blank;
    });
  };
  const out: Record<string, unknown> = { ...answer };
  if ('company_types' in answer) out.company_types = withoutBlank(answer.company_types, 'term');
  if ('job_titles' in answer) out.job_titles = withoutBlank(answer.job_titles, 'title');
  onDropped(dropped);
  return out;
}

/**
 * Обязательные поля, из-за которых ответ модели непригоден: ПУСТОЙ список
 * (`too_small` ровно на пути поля) и ОТСУТСТВУЮЩИЙ (`invalid_type` на том же
 * пути — ключа нет, null или не список). Пути у них одинаковые — «job_titles»,
 * — и различает их только код: раньше обрезанный ответ, который ремонт JSON
 * закрыл без job_titles, назывался «пустым словарём». Проблемы ВНУТРИ
 * элементов («company_types.3.kind») сюда не попадают — это формат ответа.
 */
function unusableVocabFields(error: LLMValidationError): {
  empty: RequiredVocabField[];
  missing: RequiredVocabField[];
} {
  const empty: RequiredVocabField[] = [];
  const missing: RequiredVocabField[] = [];
  const zodError = error.zodError;
  if (!(zodError instanceof z.ZodError)) return { empty, missing };
  for (const issue of zodError.issues) {
    if (issue.path.length !== 1) continue;
    const field = REQUIRED_VOCAB_FIELDS.find((f) => f === issue.path[0]);
    if (!field) continue;
    if (issue.code === 'too_small' && !empty.includes(field)) empty.push(field);
    if (issue.code === 'invalid_type' && !missing.includes(field)) missing.push(field);
  }
  return { empty, missing };
}

/**
 * Последний ответ не был целым JSON — его закрыл ремонт усечённого ответа
 * (tryRepairTruncatedJson в llm.ts). Тот же разбор, что у вызова: снять
 * markdown-фенс и распарсить.
 */
function vocabAnswerWasCut(rawText: string): boolean {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    JSON.parse(cleaned);
    return false;
  } catch {
    return true;
  }
}

/**
 * Непригодный словарь: отказ, который повтор стадии не лечит. Два случая —
 * обязательный список пуст или его нет в ответе вовсе (ответ обрезан и закрыт
 * ремонтом JSON раньше поля либо модель поле пропустила); текст отказа
 * называет, какой именно.
 *
 * Класс терминальный (дискриминант heJobTerminal читает воркер, isHeJobTerminal)
 * ровно по арифметике оплаты. Внутри ОДНОГО вызова модель уже получила второй
 * заход с фидбэком про эту самую пустоту (SCHEMA_ATTEMPTS = 2), то есть честная
 * цена вопроса — два bulk-вызова. Без терминальности к ним прибавлялись ещё две
 * полные попытки джобы (MAX_ATTEMPTS = 3) с тем же промптом на том же тексте
 * вертикали: шесть оплаченных вызовов, чтобы шесть раз услышать один ответ.
 * Провайдер тут ни при чём — молчит предметная область (или ответ на неё не
 * помещается в лимит), а она за пять минут не меняется, и разбирать это
 * человеку. Отсутствующее поле терминально по той же арифметике: повтор идёт
 * тем же промптом с тем же лимитом токенов и почти наверняка обрежется в том же
 * месте — шесть вызовов вместо двух ради одного и того же ответа.
 */
class HeVocabEmptyError extends Error {
  /** Дискриминант: instanceof ложен, если в бандле окажется две копии модуля. */
  readonly heJobTerminal = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'HeVocabEmptyError';
  }
}

/**
 * Вызов модели вокабуляра с ЧЕСТНЫМ исходом «словарь пуст».
 *
 * Схема требует хотя бы один тип компаний и хотя бы одну должность, поэтому
 * пустой ответ модели становится ошибкой валидации и получает штатный повтор с
 * фидбэком. Но одного повтора мало: если пусто и во второй раз, стадия обязана
 * сказать ПОЧЕМУ она встала, иначе сообщение будет «LLM вернул невалидный JSON»
 * — про формат, хотя формат в порядке.
 *
 * До порога оба потребителя молча теряли данные: план сбора
 * (stages/baseCollect.ts) уходил в источники без терминов компаний, досье
 * (stages/dossier.ts) считало hh-вакансии не по тем ролям, и в логе была
 * только строка «продолжаем без …».
 *
 * Различение важно для цены: пустой или отсутствующий список — терминально
 * (см. HeVocabEmptyError), кривой элемент внутри списка — про формат ответа, и
 * ему повторы положены как любому схемному сбою. Пустой элемент к кривым не
 * относится: он выбрасывается до схемы (dropBlankVocabEntries).
 */
async function callVocabModel(messages: LLMMessage[], model: string, log: (msg: string) => void) {
  // Сколько пустых элементов выбросила последняя проверка схемы — то есть та,
  // чей ответ и вернулся (у каждой попытки схемы свой разбор, значение
  // перезаписывается, а не копится).
  let blankDropped = 0;
  const schema = z.preprocess(
    (value) => dropBlankVocabEntries(value, (count) => {
      blankDropped = count;
    }),
    HeVocabSchema,
  );
  try {
    const llm = await callLLMWithSchema(messages, schema, { model, maxTokens: VOCAB_MAX_TOKENS });
    if (blankDropped > 0) {
      log(`[vocab] модель вернула пустых элементов словаря: ${blankDropped} — выброшены, остальное принято`);
    }
    return llm;
  } catch (error) {
    if (error instanceof LLMValidationError) {
      const { empty, missing } = unusableVocabFields(error);
      if (empty.length > 0 || missing.length > 0) {
        const reasons: string[] = [];
        // Разбор — по ПОСЛЕДНЕМУ ответу (его схема и текст приезжают в ошибке);
        // первый тоже не прошёл схему, но чем именно — здесь не видно.
        if (empty.length > 0) {
          // «Пусто» — и `[]`, и список из одних пустых элементов (их выбросил
          // dropBlankVocabEntries): фраза верна для обоих.
          reasons.push(`и после повтора с фидбэком в списке нет ни одного непустого элемента (${empty.join(', ')})`);
        }
        if (missing.length > 0) {
          reasons.push(
            vocabAnswerWasCut(error.rawText)
              ? `и после повтора ответ модели пришёл не целым JSON (обрезан по лимиту ${VOCAB_MAX_TOKENS} `
                + `токенов или сломан), и ремонт закрыл его раньше поля (${missing.join(', ')})`
              : `и после повтора в ответе модели нет поля (${missing.join(', ')})`,
          );
        }
        throw new HeVocabEmptyError(
          `[vocab] словарь непригоден: ${reasons.join('; ')}. ` +
            'Без типов компаний план сбора остался бы без терминов источника, ' +
            'без должностей досье считало бы не те роли. Стадия остановлена, ' +
            'повтор тем же промптом её не починит — нужен человек: уточните или сузьте описание вертикали ' +
            'и запустите заново.',
        );
      }
      // Кривой элемент — формат ответа: штатный повтор схемного сбоя. Пути — в
      // лог, чтобы специалист не путал это с пустым словарём.
      const paths = llmValidationIssuePaths(error);
      if (paths.length > 0) {
        log(
          `[vocab] ответ модели и после повтора не прошёл схему (${paths.slice(0, 6).join(', ')}`
            + `${paths.length > 6 ? ', …' : ''}) — это формат ответа, а не пустой словарь`,
        );
      }
    }
    throw error;
  }
}

export async function runVocabStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const verticalId = payloadString(job, 'vertical_id');

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', verticalId)
    .single();
  if (vError || !verticalRow) throw new Error(`he_verticals ${verticalId}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as HeVertical;

  const { data: hyps, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('title, description, tier, status')
    .eq('project_id', job.project_id)
    .eq('vertical_id', verticalId);
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  // Разметка специалиста: rejected уходят из промпта, accepted — первыми.
  const selection = selectPromptHypotheses(
    (hyps ?? []) as Array<Pick<HeHypothesis, 'title' | 'description' | 'tier' | 'status'>>,
  );
  if (selection.fallbackUsed) {
    stageLog(ctx, '[vocab] все гипотезы вертикали отклонены специалистом — используем полный список без разметки');
  }
  const hypotheses = selection.list.map((h) => ({
    title: h.title,
    description: h.description,
    tier: h.tier,
    confirmed: h.status === 'accepted',
  }));

  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(await readProject(ctx.supabase, job.project_id));

  // Цель отбора, а не текст для клиента: из матрицы вокабуляра термины
  // (company_types) и запросы (search_queries) уезжают прямо в сбор базы, и
  // мотив покупки внутри summary превращается в термины вида «companies that
  // need outbound» — таких компаний источники не знают, а запрос к каталогу по
  // ним пустой. Поэтому на EN режем мотив тем же правилом, что гейт и проба
  // среза (companyPartOfSummaryEn). Контекст «почему покупают» матрица не
  // теряет: боли и мотивы приходят списком гипотез ниже, а он для сегментов и
  // объявлен ПЕРВИЧНЫМ источником. RU-ветка (legacy /tools/hypothesis-engine)
  // получает summary как раньше, байт-в-байт.
  //
  // Срез мотива НЕ общий для всех потребителей summary, и это надо знать.
  // EN-планировщик источников (stages/baseCollect.ts, collectPlanInput →
  // buildSourcePlanMessagesEn и его ремонтный и расширяющий варианты) и
  // проверка «порог размера обоснован» (heSizeBasisEn) получают summary
  // ЦЕЛИКОМ, вместе с «They buy because …» — хотя довод выше (мотив даёт
  // фильтры каталога, под которые компаний нет) к планировщику относится так
  // же. Порезать его и там — отдельное решение с ценой: вход планировщика
  // хешируется в ключ переиспользования плана (heCatalogPlanKey), поэтому такая
  // правка обнулит сохранённые планы всех ENG-вертикалей, и каждая купит новый
  // план и новую пробу среза.
  const summary = vertical.summary ?? '';
  const model = getHeModel('bulk');
  const llm = await callVocabModel(
    (market === 'us' ? buildVocabMessagesEn : buildVocabMessages)({
      verticalName: vertical.name,
      verticalSummary: market === 'us' ? companyPartOfSummaryEn(summary) : summary,
      synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
      hypotheses,
    }),
    model,
    (msg) => stageLog(ctx, msg),
  );
  addUsage(usage, llm);
  const vocab = llm.data;

  // Best-effort верификация топовых типов компаний: термин, который поиск
  // не знает вообще, помечаем в notes — специалист увидит и снимет.
  //
  // Стадию отказ поиска НЕ валит (в отличие от исследования): матрица уже
  // получена моделью, и терять её вместе с оплаченным вызовом из-за
  // необязательной проверки нельзя. Но и молчать нельзя — до правки отказ
  // провайдера проходил пустым catch'ем, и вокабуляр выглядел проверенным.
  // Пометку «поиском не подтверждён» при отказе НЕ ставим: это утверждение о
  // термине, а мы его не проверяли.
  const search = resolveSearch(ctx);
  const jobSignal = heStageSignal(ctx);
  const tally = newHeSearchTally();
  const companyTypes = [...vocab.company_types];
  const verifyIdxs = companyTypes
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind === 'canonical' || t.kind === 'synonym')
    .slice(0, TERMS_TO_VERIFY)
    .map(({ i }) => i);
  for (const i of verifyIdxs) {
    const term = companyTypes[i];
    // Провайдер уже отказал — остальные проверки повторят тот же отказ.
    if (tally.failure) break;
    try {
      const items = await search(`"${term.term}" ${vertical.name}`);
      noteHeSearchAnswered(tally);
      if (!items.length) {
        companyTypes[i] = {
          ...term,
          notes: term.notes ? `${term.notes}; поиском не подтверждён` : 'поиском не подтверждён',
        };
        stageLog(ctx, `[vocab] термин «${term.term}» не подтверждён поиском`);
      }
    } catch (e) {
      // Отмена задачи — не «поиск упал»: вставлять he_vocab после отмены незачем.
      if (jobSignal?.aborted) throw e;
      noteHeSearchFailure(tally, e);
      stageLog(ctx, `[vocab] верификация терминов пропущена, поиск отказал: ${heIoFailureReason(e)}`);
    }
  }

  // То же для запросов к реестрам/каталогам: код или источник, который поиск
  // не находит вообще, помечаем в notes — специалист увидит и снимет.
  const searchQueries = [...vocab.search_queries];
  const queryIdxs = searchQueries
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => /registry|catalog/i.test(q.source))
    .slice(0, REGISTRY_QUERIES_TO_VERIFY)
    .map(({ i }) => i);
  for (const i of queryIdxs) {
    const q = searchQueries[i];
    if (tally.failure) break;
    try {
      const items = await search(q.query);
      noteHeSearchAnswered(tally);
      if (!items.length) {
        searchQueries[i] = {
          ...q,
          notes: q.notes ? `${q.notes}; поиском не подтверждён` : 'поиском не подтверждён',
        };
        stageLog(ctx, `[vocab] запрос «${q.query}» (${q.source}) не подтверждён поиском`);
      }
    } catch (e) {
      if (jobSignal?.aborted) throw e;
      noteHeSearchFailure(tally, e);
      stageLog(ctx, `[vocab] верификация запросов пропущена, поиск отказал: ${heIoFailureReason(e)}`);
    }
  }
  if (tally.failure && tally.answered === 0) {
    // Итог одной строкой: вокабуляр уехал в he_vocab непроверенным, и это
    // видно в логе, а не только по отсутствию пометок.
    stageLog(ctx, '[vocab] вокабуляр сохранён БЕЗ верификации поиском — поиск не обслужил ни одного запроса');
  }

  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_vocab')
    .insert({
      vertical_id: verticalId,
      company_types: companyTypes,
      job_titles: vocab.job_titles,
      search_queries: searchQueries,
      status: 'ready',
      llm_model: model,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_vocab insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: {
      vocab_id: (inserted as { id: string }).id,
      company_types: companyTypes,
      job_titles: vocab.job_titles,
      search_queries: searchQueries,
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
