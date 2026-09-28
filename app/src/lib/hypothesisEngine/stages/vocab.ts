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

/**
 * Пустой словарь: отказ, который повтор стадии не лечит.
 *
 * Класс терминальный (дискриминант heJobTerminal читает воркер, isHeJobTerminal)
 * ровно по арифметике оплаты. Внутри ОДНОГО вызова модель уже получила второй
 * заход с фидбэком про эту самую пустоту (SCHEMA_ATTEMPTS = 2), то есть честная
 * цена вопроса — два bulk-вызова. Без терминальности к ним прибавлялись ещё две
 * полные попытки джобы (MAX_ATTEMPTS = 3) с тем же промптом на том же тексте
 * вертикали: шесть оплаченных вызовов, чтобы шесть раз услышать один ответ.
 * Провайдер тут ни при чём — молчит предметная область, а она за пять минут не
 * меняется, и разбирать это человеку.
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
 * Различение остаётся прежним и оно важно для цены: пустой список — это про
 * предметную область (терминально), кривой элемент внутри списка — про формат
 * ответа, и ему повторы положены как любому схемному сбою.
 */
async function callVocabModel(messages: LLMMessage[], model: string) {
  try {
    return await callLLMWithSchema(messages, HeVocabSchema, { model, maxTokens: 8192 });
  } catch (error) {
    if (error instanceof LLMValidationError) {
      const paths = llmValidationIssuePaths(error);
      // Пустой список на верхнем уровне даёт путь ровно «company_types»;
      // кривой элемент — «company_types.0.term», и это другая новость.
      const empty = REQUIRED_VOCAB_FIELDS.filter((field) => paths.includes(field));
      if (empty.length > 0) {
        throw new HeVocabEmptyError(
          `[vocab] модель дважды вернула пустой словарь (${empty.join(', ')}): ` +
            'без типов компаний план сбора остался бы без терминов источника, ' +
            'без должностей досье считало бы не те роли. Стадия остановлена, ' +
            'повтор её не починит — нужен человек: уточните описание вертикали и запустите заново.',
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
