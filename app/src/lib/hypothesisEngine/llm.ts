/**
 * LLM-хелпер «Движка вертикалей». Копия паттерна salesAiAnalysis/llm.ts:
 * Requesty router (OpenAI-compatible), response_format: json_object +
 * Zod-валидация + 1 retry с фидбэком об ошибке, учёт токенов/стоимости.
 *
 * Отличия от salesAiAnalysis:
 *  - свой ключ: OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (fallback OPENROUTER_BRIEF_API_KEY);
 *    у работы проектов market='us' — HE_US_REQUESTY_API_KEY, если задан
 *    (providerKeys.ts, getApiKey ниже);
 *  - четыре роли моделей (см. getHeModel): research / chain / bulk / gate;
 *  - дополнительный callLLMText — свободный текст без json_object
 *    (цепочки писем парсятся маркерами ---LETTER N---, а не схемой);
 *  - у английского промпта проекта market='us' служебные сообщения JSON-режима
 *    английские, и повтор схемы переигрывает предыдущий ответ целиком (до
 *    32 000 символов); остальные вызовы — по-русски, как раньше
 *    (jsonHintLanguage).
 *
 * Учёт расхода — ДВА правила, развилка по рынку проекта (heLlmEngAccounting):
 *
 *  - market='us' (ENG). Расход вызова берётся из usage.cost роутера — это
 *    цена, которую Requesty выставил (с его наценкой, кешем и фактической
 *    моделью ответа). Таблица MODEL_PRICES (USD/M токенов, прайс Requesty на
 *    момент написания) — только запасной путь, когда роутер usage.cost не
 *    вернул, с наценкой роутера; при смене моделей её всё равно обновлять.
 *    Фолбэка «считать по самой дорогой» здесь нет. Модель без ставки прогон не
 *    останавливает, а сам пробел в таблице виден в логе (см. costOfCall).
 *    Оплаченные и отброшенные попытки схемы входят в итог вызова, в канал
 *    расхода воркера (onSpend) и в текст отказа («оплачено и отброшено»).
 *    От этого правила зависят журнал расхода и потолки ENG — не трогать.
 *  - любой другой рынок (RU-инструмент специалистов) — как до порта ENG
 *    (решение владельца 14.10.2026 «Как было», подтверждено 15.10.2026; код
 *    46bd0e82e): цена — только по замороженной таблице HE_RU_MODEL_PRICES,
 *    неизвестная модель — по ставке opus; usage.cost и наценка не читаются; в
 *    итог вызова идёт расход только принятой попытки; канал onSpend молчит;
 *    текст отказа — прежний, без суффикса.
 *
 * Развилка по рынку — ТОЛЬКО учёт расхода. Промпты и тела запросов у RU — как
 * до порта, а транспорт (повторы внутри вызова, срок попытки, классы сбоя
 * HeLlmHttpError) общий для обоих рынков: он остаётся у RU по тому же решению
 * (паузы повторов, сроки и сторож — в списке «оставить»).
 *
 * Транспорт (раздел «Транспорт» ниже): у каждой ПОПЫТКИ есть свой срок и
 * ограниченные повторы. Классы сбоя — типизированные (HeLlmHttpError.kind,
 * HeLlmTransportError, HeLlmTimeoutError), и решение о повторе принимается по
 * типу, а не по тексту сообщения: в этом движке «aborted» означает отмену
 * пользователем, и regexp принял бы отмену за транзиентный сбой.
 *
 * Признак жизни (волна 3, полоса F1): каждая попытка запроса отмечается через
 * канал активной джобы (setHeActiveJob → onActivity) — ТОТ ЖЕ вход сторожа
 * простоя воркера, что и у операций стадий (ctx.onActivity, stages/io.ts).
 * Без этого самое длинное ЗАКОННОЕ молчание движка — генерация ответа модели —
 * выглядело для сторожа зависанием, прерывание считалось бесплатным, и самый
 * дорогой вызов проекта оплачивался заново. Второго механизма живости не
 * заводим: канал один, сток один (watchdog.touch()).
 *
 * Журнал расхода ENG (P-A-provider-usage-journal, costTelemetry.ts): каждое
 * HTTP-обращение к роутеру (rawCall, включая транспортные повторы) даёт строку
 * application_logs 'he_provider_usage' — только когда журнал открыт, то есть
 * у проектов market='us': джобы воркера и запуск шаблона (классификатор
 * сегментов; роуты запуска клиента и staff). RU-джобы, остальные роуты и CLI
 * журнала не имеют: крючок там — немедленный выход. Запись фоновая и не
 * бросает: платный вызов её не ждёт, и её сбой стадию не роняет.
 */

import { z } from 'zod';

import { isHeProviderBillingError, isHeProviderConfigurationError } from './clientErrors';
import {
  heProviderJournalActive,
  heProviderJournalMarket,
  noteHeProviderCall,
  type HeProviderCallOutcome,
  type HeRequestyCall,
} from './costTelemetry';
import type { HeMarket } from './market';
import { HE_US_REQUESTY_KEY_ENV, heUsProviderKey } from './providerKeys';

const API_URL = 'https://router.requesty.ai/v1/chat/completions';

interface RequestyResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

type ModelPrices = { in: number; out: number };
const MODEL_PRICES: Record<string, ModelPrices> = {
  // Ресёрч/синтез (site_profile, hypotheses, evidence, clustering)
  // opus-5: прайс Requesty уточнить после первых прогонов, пока = opus-4-8
  'claude-opus-5':                  { in: 5.0, out: 25.0 },
  'anthropic/claude-opus-5':        { in: 5.0, out: 25.0 },
  'claude-opus-4-8':                { in: 5.0, out: 25.0 },
  'anthropic/claude-opus-4-8':      { in: 5.0, out: 25.0 },
  // Bulk: vocab, brand_cloud-классификация, base_analyze
  'claude-sonnet-4-6':              { in: 3.0, out: 15.0 },
  'anthropic/claude-sonnet-4-6':    { in: 3.0, out: 15.0 },
  // Цепочки/шаблоны (как emailSequenceV2)
  'gpt-5.2':                        { in: 1.25, out: 10.0 },
  'openai/gpt-5.2':                 { in: 1.25, out: 10.0 },
  // Прод-модели после A/B eval (2026-08), прайс Requesty USD/M токенов.
  // gpt-5.5 сверен со ставкой соседнего движка (verticalEngineV2/llm.ts,
  // 5.0/30.0): здесь стояло 4.5/27.0, на 10% ниже, а это модель research и
  // bulk в проде (docker-compose.prod.yml, HE_MODEL_RESEARCH/HE_MODEL_BULK).
  'gpt-5.5':                        { in: 5.0, out: 30.0 },
  'openai/gpt-5.5':                 { in: 5.0, out: 30.0 },
  'gemini-3.1-pro-preview':         { in: 1.8, out: 10.8 },
  'google/gemini-3.1-pro-preview':  { in: 1.8, out: 10.8 },
  // Дефолт роли gate (HE_MODEL_DEFAULTS.gate) — самый массовый вызов движка:
  // relevanceGate (до 60 батчей на базу), segmentClassify, sliceProbe, caseBank.
  // Без этой строки он считался по фолбэку opus ($5/$25), то есть в ~33× дороже
  // факта по входным токенам. Прайс Requesty /v1/models, 2026-09-08.
  'gpt-4o-mini':                    { in: 0.15, out: 0.60 },
  'openai/gpt-4o-mini':             { in: 0.15, out: 0.60 },
  // На случай downgrade через env
  'claude-haiku-4-5':               { in: 1.0, out: 5.0 },
  'anthropic/claude-haiku-4-5':     { in: 1.0, out: 5.0 },
};

function lookupPrices(model: string): ModelPrices | undefined {
  // Датированный алиас («…-2024-07-18»), например в env, считаем по базовой
  // ставке — иначе он молча уходил бы в «модель без ставки».
  return MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}

/** Уже залогированные пробелы (модель + повод): до 60 вызовов гейта на базу, без дедупа лог зашумится. */
const unpricedLogged = new Set<string>();

/**
 * Один раз на модель и повод сказать в лог, что ставки нет.
 *
 * Пропуск в MODEL_PRICES — ошибка конфигурации (опечатка в env, переименование
 * модели у провайдера, новая роль без ставки), и заметить её больше негде:
 * cost_usd у he_jobs/he_projects — numeric not null, который воркер только
 * прибавляет (`Number(job.cost_usd ?? 0) + …`), «неизвестно» в нём не
 * выражается, а llm_model пишется лишь у части артефактов (chain/template/
 * dossier), у джобы gate/bulk — нет. Поэтому лог — единственный канал, и
 * молчать в нём нельзя: иначе отчёт о себестоимости занижается тихо.
 * Исключение — проекты ENG (market='us') под журналом расхода (джобы воркера,
 * запуск шаблона): там тот же пробел виден и в журнале строкой с
 * price_known=false (journalRequestyCall ниже), и отчёт по журналу
 * (costReport.ts) не называет такой итог полным.
 */
function noteUnpriced(model: string, reason: string, detail: string): void {
  const key = `${model}|${reason}`;
  if (unpricedLogged.has(key)) return;
  unpricedLogged.add(key);
  console.error(`[he-llm] нет ставки в MODEL_PRICES для модели '${model}': ${detail}`);
}

/**
 * Ключ роутера для ЭТОГО вызова. Работа проекта market='us' (под журналом
 * расхода ENG) идёт по своему ключу HE_US_REQUESTY_API_KEY, если он задан;
 * иначе — и у любого вызова вне журнала — прежний общий ключ (providerKeys.ts).
 */
function getApiKey(): string {
  const engKey = heUsProviderKey(HE_US_REQUESTY_KEY_ENV);
  if (engKey) return engKey;
  const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_HYPOTHESIS_ENGINE_API_KEY не задан (и нет fallback OPENROUTER_BRIEF_API_KEY)');
  }
  return key;
}

/**
 * Наценка роутера поверх прайса модели. Ставки MODEL_PRICES — прайс без неё, а
 * usage.cost её уже содержит, поэтому оценка по таблице умножается на тот же
 * множитель, что и у соседнего движка (verticalEngineV2/llm.ts: «Reserve
 * estimates include its 5% markup»). Иначе запасной путь систематически занижал бы
 * расход на эти 5%.
 */
const REQUESTY_MARKUP = 1.05;

/**
 * Стоимость вызова по правилу ENG (market='us', heLlmEngAccounting; RU-проекты
 * считает ruCostOfCall). Порядок: фактический `usage.cost` роутера → ставка из
 * MODEL_PRICES с наценкой роутера → 0 с записью в лог.
 *
 * usage.cost — первым: это цена, которую выставил Requesty (в VE2 это и есть
 * источник аудита расхода), и в ней уже учтены наценка роутера, кешированные
 * токены и модель, фактически ответившая на запрос. Таблица этого не знает
 * ничего, поэтому раньше, при наличии ставки, точная цифра роутера
 * выбрасывалась, и расход по моделям с ставкой стабильно занижался.
 *
 * Ставки может не быть у модели из env или из явного opts.model, и бросать
 * здесь нельзя: к моменту подсчёта вызов уже оплачен, стадия упала бы ПОСЛЕ
 * успешного ответа модели — пробел в бухгалтерии не повод останавливать
 * работающий платный прогон. Ставку «самой дорогой» модели не выдумываем ни
 * при каких условиях. Если нет ни usage.cost, ни ставки — вклад нулевой (сумму
 * складывают в stages/shared.ts и прибавляют к numeric-колонке, NaN сломал бы
 * её), но не молча: см. noteUnpriced.
 */
function costOfCall(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reportedCostUsd?: number,
): number {
  const p = lookupPrices(model);
  if (reportedCostUsd !== undefined) {
    if (!p) {
      noteUnpriced(
        model,
        'router',
        `расход взят из usage.cost роутера ($${reportedCostUsd}), но без него этот вызов ушёл бы в ноль — допишите ставку в hypothesisEngine/llm.ts`,
      );
    }
    return reportedCostUsd;
  }
  if (p) return tableCostOfCall(p, promptTokens, completionTokens);
  noteUnpriced(model, 'missing', 'и роутер не вернул usage.cost — расход этого вызова НЕ попал в cost_usd, допишите ставку в hypothesisEngine/llm.ts');
  return 0;
}

/** Оценка по ставке таблицы с наценкой роутера — одна формула для he_jobs и журнала. */
function tableCostOfCall(p: ModelPrices, promptTokens: number, completionTokens: number): number {
  return ((promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out) * REQUESTY_MARKUP;
}

/**
 * Прайс RU-учёта — ЗАМОРОЖЕННАЯ копия таблицы до порта ENG (46bd0e82e), байт в
 * байт: gpt-5.5 по 4.5/27.0, строки gpt-4o-mini нет (вызовы роли gate RU —
 * гейт, классификатор, кейсы, пробы — поэтому, как и до порта, считаются по
 * opus, примерно в 33 раза дороже факта). Решение владельца 14.10.2026 «Как
 * было» (подтверждено 15.10.2026): cost_usd RU-проектов считается так же, как
 * до порта, поэтому правки MODEL_PRICES (ставки ENG и журнала) сюда НЕ
 * переносятся. Новую модель в RU — дописать сюда отдельным решением, иначе она
 * считается по opus.
 */
const HE_RU_MODEL_PRICES: Record<string, ModelPrices> = {
  'claude-opus-5':                  { in: 5.0, out: 25.0 },
  'anthropic/claude-opus-5':        { in: 5.0, out: 25.0 },
  'claude-opus-4-8':                { in: 5.0, out: 25.0 },
  'anthropic/claude-opus-4-8':      { in: 5.0, out: 25.0 },
  'claude-sonnet-4-6':              { in: 3.0, out: 15.0 },
  'anthropic/claude-sonnet-4-6':    { in: 3.0, out: 15.0 },
  'gpt-5.2':                        { in: 1.25, out: 10.0 },
  'openai/gpt-5.2':                 { in: 1.25, out: 10.0 },
  'gpt-5.5':                        { in: 4.5, out: 27.0 },
  'openai/gpt-5.5':                 { in: 4.5, out: 27.0 },
  'gemini-3.1-pro-preview':         { in: 1.8, out: 10.8 },
  'google/gemini-3.1-pro-preview':  { in: 1.8, out: 10.8 },
  'claude-haiku-4-5':               { in: 1.0, out: 5.0 },
  'anthropic/claude-haiku-4-5':     { in: 1.0, out: 5.0 },
};

/** Фолбэк RU-учёта, как до порта: модель без ставки — по самой дорогой (opus). */
const HE_RU_FALLBACK_PRICES: ModelPrices = HE_RU_MODEL_PRICES['anthropic/claude-opus-4-8'];

/**
 * Стоимость вызова RU-проекта — формула до порта ENG (estimateCost из
 * 46bd0e82e): только таблица, без usage.cost роутера, без наценки, без
 * дат-алиасов и без строки в лог.
 */
function ruCostOfCall(model: string, promptTokens: number, completionTokens: number): number {
  const p = HE_RU_MODEL_PRICES[model] ?? HE_RU_FALLBACK_PRICES;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}

/**
 * Считать ли этот вызов по правилу ENG (см. шапку файла). Рынок — явный
 * opts.market вызывающего, а без него — рынок работы под журналом расхода ENG
 * (costTelemetry.ts: журнал открыт только у проектов market='us' — джобы
 * воркера, оба роута запуска шаблона, автозапуск). Всё остальное — RU-учёт,
 * как до порта: RU-джобы, staff-роуты RU и вызов, рынок которого не известен
 * (запуск шаблона с непрочитанным рынком проекта). Ошибка в сторону RU даёт
 * ровно прежнее поведение RU-инструмента.
 */
function heLlmEngAccounting(market: HeMarket | undefined): boolean {
  return (market ?? heProviderJournalMarket()) === 'us';
}

/**
 * Строка журнала расхода ENG на ОДНО HTTP-обращение к роутеру
 * (costTelemetry.ts). Журнал открыт только у проектов market='us': в воркере
 * вокруг стадии и в роутах запуска шаблона вокруг ядра запуска (классификатор
 * сегментов). Вне его (RU-проект, другие роуты, CLI) — немедленный выход,
 * ничего не считается и не пишется. Ничего не ждёт.
 *
 * НИКОГДА НЕ БРОСАЕТ — по построению, а не по разбору: всё тело под
 * try/catch. Зовётся изнутри try в rawCall, и бросок отсюда после оплаченного
 * 200 ушёл бы в его catch — оплаченный ответ стал бы транспортным отказом и
 * повтором за деньги, а после 4xx/5xx перекрасил бы класс отказа. Сбой журнала
 * стоит одной строки журнала, не вызова.
 *
 * Цена — по тому же правилу, что costOfCall (счёт роутера → ставка таблицы),
 * но «не знаем» здесь — null, а не 0: у he_jobs.cost_usd ноль вынужденный
 * (numeric not null, туда прибавляют), у журнала — нет. По таблице цена
 * считается, только если в usage есть число prompt_tokens или
 * completion_tokens: ответ без блока usage или с одним total_tokens — без цены
 * (0 токенов × ставка дали бы ложный «известный ноль»).
 */
function journalRequestyCall(
  model: string,
  outcome: HeProviderCallOutcome,
  httpStatus: number | undefined,
  response?: RequestyResponse,
): void {
  try {
    if (!heProviderJournalActive()) return;
    let usage: HeRequestyCall['usage'];
    let costUsd: number | null = null;
    let costSource: HeRequestyCall['costSource'] = null;
    const raw = response?.usage;
    if (raw && typeof raw === 'object') {
      const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
      const counted = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens].some(finite);
      // Ставке таблицы нужны токены входа или выхода; одного total_tokens мало.
      const priceable = [raw.prompt_tokens, raw.completion_tokens].some(finite);
      const { promptTokens, completionTokens, tokensUsed, reportedCostUsd } = usageOf(response!);
      if (counted) usage = { tokensIn: promptTokens, tokensOut: completionTokens, tokensTotal: tokensUsed };
      const p = lookupPrices(model);
      if (reportedCostUsd !== undefined) {
        costUsd = reportedCostUsd;
        costSource = 'router';
      } else if (priceable && p) {
        costUsd = tableCostOfCall(p, promptTokens, completionTokens);
        costSource = 'table';
      }
    }
    noteHeProviderCall({
      provider: 'requesty',
      model,
      outcome,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(usage ? { usage } : {}),
      costUsd,
      costSource,
    });
  } catch {
    // Разбор usage сорвался — строка обращения всё равно ложится, но без
    // токенов и цены (отчёт назовёт итог нижней границей, а не полным). Не
    // легла и она — молча: исход вызова решает только ответ провайдера.
    try {
      noteHeProviderCall({ provider: 'requesty', model, outcome, costUsd: null, costSource: null });
    } catch {
      // см. выше
    }
  }
}

/* ─────────────────────── Роли моделей ─────────────────────── */

export type HeModelKind = 'research' | 'chain' | 'bulk' | 'gate';

const HE_MODEL_DEFAULTS: Record<HeModelKind, string> = {
  research: 'anthropic/claude-opus-5',
  chain: 'anthropic/claude-opus-5',
  bulk: 'anthropic/claude-sonnet-4-6',
  // Дешёвые классификационные задачи (relevance-gate, сегмент-классификатор,
  // case-bank): мини-модели хватает, reasoning-расходы и усечения max_tokens
  // на reasoning-моделях (finish_reason='length') здесь не нужны вовсе.
  gate: 'openai/gpt-4o-mini',
};

const HE_MODEL_ENV: Record<HeModelKind, string> = {
  research: 'HE_MODEL_RESEARCH',
  chain: 'HE_MODEL_CHAIN',
  bulk: 'HE_MODEL_BULK',
  gate: 'HE_MODEL_GATE',
};

/**
 * Модель для роли движка; переопределяется env HE_MODEL_RESEARCH/CHAIN/BULK/GATE.
 * Про отсутствие ставки говорим здесь же — при чтении конфигурации, с именем
 * env: так опечатка видна на первой стадии, а не только по факту вызовов.
 * Модель при этом возвращаем как есть: файл обслуживает и штатный RU-инструмент
 * специалистов, и ENG-ресёрч, и остановить их из-за пробела в прайсе нельзя.
 */
export function getHeModel(kind: HeModelKind): string {
  const configured = (process.env[HE_MODEL_ENV[kind]] ?? '').trim();
  const model = configured || HE_MODEL_DEFAULTS[kind];
  if (!lookupPrices(model)) {
    noteUnpriced(
      model,
      'config',
      `роль '${kind}' (${configured ? HE_MODEL_ENV[kind] : `HE_MODEL_DEFAULTS.${kind}`}) — ` +
        `расход проектов market='us' считается по usage.cost роутера, а когда его нет — в ноль ` +
        `(RU-проекты — по HE_RU_MODEL_PRICES, как до порта ENG): допишите ставку в hypothesisEngine/llm.ts`,
    );
  }
  return model;
}

/* ─────────────────────── Базовые типы/вызов ─────────────────────── */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult<T> {
  data: T;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  rawResponse: unknown;
}

export interface LLMTextResult {
  text: string;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  rawResponse: unknown;
  /** finish_reason первого choice ('stop' | 'length' | 'content_filter' | ...). */
  finishReason?: string;
}

export class LLMValidationError extends Error {
  constructor(message: string, public readonly rawText: string, public readonly zodError?: unknown) {
    super(message);
    this.name = 'LLMValidationError';
  }
}

/**
 * Пути схемы, по которым ответ не прошёл валидацию («company_types»,
 * «job_titles.0.title»). Стадии нужен честный повод отказа, а не текст zod'а:
 * пустой массив на верхнем уровне и опечатка внутри элемента — разные новости
 * для специалиста. Пустой результат = причина не в схеме (усечение, синтаксис,
 * транспорт). Единственный читатель сегодня — stages/vocab.ts.
 */
export function llmValidationIssuePaths(error: unknown): string[] {
  const zodError = error instanceof LLMValidationError ? error.zodError : error;
  if (!(zodError instanceof z.ZodError)) return [];
  return zodError.issues.map((issue) => issue.path.join('.'));
}

/**
 * Общие опции вызова модели.
 *
 * Своего `signal` и своего `timeoutMs` здесь СОЗНАТЕЛЬНО нет (были заведены как
 * точка расширения и остались без единого писателя из ~30 вызовов движка):
 *  - отмена приходит одним каналом активной джобы (setHeActiveJob ниже) —
 *    второй источник сигнала означал бы, что отмену можно не заметить;
 *  - срок считается от maxTokens и обязан быть МЕНЬШЕ окна сторожа простоя
 *    (см. llmAttemptTimeoutMs). Опция «свой срок» позволяла вызывающему
 *    перевернуть этот порядок и вернуть ровно тот баг, который волна лечит.
 */
export interface HeLlmCallOptions {
  model: string;
  maxTokens?: number;
  /**
   * Рынок проекта — только для правила учёта расхода (heLlmEngAccounting).
   * Передаёт его вызывающий, который работает ВНЕ журнала расхода ENG, но знает
   * рынок (staff-структуризация кейса). Без него рынок берётся из журнала, а
   * без журнала — RU-учёт, как до порта. Ключ, язык служебных сообщений и
   * журнал от этого поля не зависят.
   */
  market?: HeMarket;
}

export interface HeLlmSchemaCallOptions extends HeLlmCallOptions {
  /**
   * Требовать ПОЛНЫЙ ответ: усечённый по max_tokens не ремонтировать, а
   * повторять и в итоге отказывать честно. Включают классификаторы, где
   * короткий список выглядит как уверенный ответ (segmentClassify).
   * Гейт релевантности НЕ включает: он fail-open по замыслу, и строгое
   * правило превратило бы частичный ответ в потерю целого батча.
   */
  requireCompleteJson?: boolean;
}

export interface HeLlmTextCallOptions extends HeLlmCallOptions {
  /** Explicitly budgeted ENG calls may forbid transport repeats; ordinary callers keep all three retries. */
  transportRetries?: 0;
  /** Ask for one JSON object without adding schema repair attempts. Default text behavior is unchanged. */
  jsonMode?: true;
  fallbackModel?: string;
  minChars?: number;
  log?: (msg: string) => void;
}

/**
 * Канал активной джобы воркера: отмена, признак жизни и лог прогона. Воркер
 * single-flight (handleJob выполняет строго одну джобу за раз), поэтому канал —
 * модульный: worker/hypothesisEngine.ts ставит его перед runHeStage и снимает
 * после. Вне воркера (API-роуты, CLI) канала нет — поведение прежнее.
 */
export interface HeActiveJobChannel {
  /**
   * Отмена задачи (he_jobs.status='cancelled') обрывает текущий HTTP-запрос к
   * модели сразу, а не по окончании стадии — деньги не догорают.
   */
  signal: AbortSignal | null;
  /**
   * Признак жизни для сторожа простоя воркера — ТОТ ЖЕ сток, что у
   * ctx.onActivity стадий (watchdog.touch()). Транспорт отмечает каждую попытку
   * запроса, включая повторы: генерация ответа — самое длинное законное
   * молчание движка, и без этой отметки сторож считал её зависанием.
   */
  onActivity?: () => void;
  /**
   * Лог прогона: у строк транспорта та же личность, что у остальных строк
   * воркера (id воркера, джобы, проекта, стадия). Без канала — console.warn
   * процесса, как было.
   */
  log?: (msg: string) => void;
  /**
   * Расход КАЖДОГО ответа модели, за который провайдер выставил счёт, —
   * включая попытки схемы, которые вызов потом отбросил. Зовётся до того, как
   * вызов решит свою судьбу, поэтому до воркера доходят и деньги вызова,
   * который в итоге бросил исключение (стадия их уже не вернёт: usage у неё
   * приезжает только вместе с результатом).
   *
   * Только по правилу учёта ENG (market='us', heLlmEngAccounting). У вызова
   * RU-проекта канал молчит, как до порта: в he_jobs идёт ровно то, что
   * вернула стадия, а упавший прогон расхода не записывает.
   *
   * Канал запоминается в начале вызова, а не читается на каждом ответе: поздний
   * ответ вызова, переживший свою джобу, иначе записался бы на следующую.
   */
  onSpend?: (spend: HeLlmSpend) => void;
}

/** Расход одного оплаченного ответа модели. */
export interface HeLlmSpend {
  tokensUsed: number;
  costUsd: number;
}

let activeJob: HeActiveJobChannel | null = null;

export function setHeActiveJob(channel: HeActiveJobChannel | null): void {
  activeJob = channel;
}

/**
 * Сигнал того же канала для стадий (stages/io.ts): отмена доходит не только до
 * LLM-запроса, но и до чтения сайта и поиска. Отдельного параметра контракта
 * для этого не вводим — воркер односоточный, источник сигнала один.
 */
export function getHeActiveJobSignal(): AbortSignal | null {
  return activeJob?.signal ?? null;
}

/** Попытка запроса началась/ответила — продлить окно сторожа простоя. */
function noteLlmActivity(): void {
  activeJob?.onActivity?.();
}

/** Строка транспорта в лог прогона (или в лог процесса, если канала нет). */
function llmLog(msg: string): void {
  const sink = activeJob?.log;
  if (sink) sink(msg);
  else console.warn(msg);
}

/**
 * Язык служебных сообщений JSON-режима: подсказки «верни JSON»
 * (withJsonModeHint) и фидбэка повтора схемы (callLLMWithSchemaAttempts).
 *
 * 'en' — только у работы проекта market='us' (под журналом расхода ENG — тот
 * же признак, по которому выбирается свой ключ, providerKeys.ts) и только
 * когда инструкции вызова написаны латиницей: латинских букв в них больше,
 * чем кириллических. Инструкции — system-сообщения, а если их нет — все
 * сообщения; в user-сообщениях приезжают данные (имена компаний), и они язык
 * не решают. Решает перевес, а не наличие кириллицы: английские промпты
 * цепочки и шаблона называют блоки материалов русскими именами
 * («ПОДПИСЬ ОТПРАВИТЕЛЯ»). Так английский промпт получает английские
 * подсказки, и русская строка внутри английского разговора больше не тянет
 * модель писать поля по-русски.
 *
 * 'ru' — всё остальное, байт-в-байт как до правки: RU-проекты, работа без
 * журнала (staff-роуты, CLI), русский промпт us-проекта (досье, цепочка на
 * русском или польском — у польской system-промпт русский). Ошибка
 * распознавания в сторону 'ru' даёт ровно прежнее поведение.
 */
type HeJsonHintLanguage = 'ru' | 'en';

const CYRILLIC_LETTERS_RE = /[\u0400-\u04FF]/g;
const LATIN_LETTERS_RE = /[A-Za-z]/g;

function jsonHintLanguage(messages: LLMMessage[]): HeJsonHintLanguage {
  if (heProviderJournalMarket() !== 'us') return 'ru';
  const system = messages.filter((m) => m.role === 'system');
  const instructions = (system.length ? system : messages).map((m) => m.content).join('\n');
  const cyrillic = instructions.match(CYRILLIC_LETTERS_RE)?.length ?? 0;
  const latin = instructions.match(LATIN_LETTERS_RE)?.length ?? 0;
  return latin > cyrillic ? 'en' : 'ru';
}

/**
 * json_object-режим отвечает 400, если слово «json» не встречается ни в одном
 * сообщении. Промпты в prompts/ формат упоминают, а инлайновые (system досье
 * собирается в stages/dossier.ts) — нет, и такая стадия падала на каждом
 * прогоне. Подсказку добавляем здесь, а не в каждом промпте. Язык — см.
 * jsonHintLanguage.
 */
function withJsonModeHint(messages: LLMMessage[], language: HeJsonHintLanguage): LLMMessage[] {
  if (messages.some((m) => /json/i.test(m.content))) return messages;
  return [
    ...messages,
    {
      role: 'user',
      content:
        language === 'en'
          ? 'Return the answer strictly as valid JSON matching the schema: no markdown fences and no text before or after.'
          : 'Верни ответ строго как валидный JSON по схеме: без markdown-фенсов и без текста до/после.',
    },
  ];
}

/**
 * Самый длинный предыдущий ответ, который английский повтор схемы переигрывает
 * целиком (то же число, что у соседнего движка). Длиннее — ответ не
 * переигрывается вовсе, а фидбэк говорит, что он опущен: обрубок длинного
 * ответа учил бы модель вернуть обрубок.
 */
const SCHEMA_RETRY_REPLAY_MAX_CHARS = 32_000;

/**
 * Хвост английского повтора схемы (jsonHintLanguage === 'en'): что дописать к
 * исходным сообщениям после отброшенной попытки. Усечённый ответ не
 * переигрывается (как и в русской ветке); непрошедший схему или синтаксис —
 * целиком, если он не длиннее SCHEMA_RETRY_REPLAY_MAX_CHARS, иначе опускается
 * с пометкой. Русская ветка — прежняя, со срезом до 2000 символов.
 */
function englishSchemaRetryMessages(previous: {
  text: string;
  error?: string;
  kind: 'truncated' | 'json_syntax' | 'schema';
}): LLMMessage[] {
  if (previous.kind === 'truncated') {
    return [
      {
        role: 'user',
        content:
          'Your previous answer did not fit into the output limit and was cut off. Return the COMPLETE result for ' +
          'the original request: every item of the list, strictly valid JSON matching the schema, with no markdown ' +
          'fences and no text before or after. Shorten field values, not the list.',
      },
    ];
  }
  const replay = previous.text.length <= SCHEMA_RETRY_REPLAY_MAX_CHARS;
  return [
    ...(replay ? [{ role: 'assistant' as const, content: previous.text }] : []),
    {
      role: 'user',
      content:
        `Your previous answer failed JSON schema validation. Error:\n` +
        `${previous.error}\n\n` +
        (replay ? '' : 'Your previous answer was too long to repeat here, so it is left out.\n') +
        'Generate the COMPLETE result for the original request again, not only the corrected parts and not a ' +
        'fragment of your previous answer. Return valid JSON strictly matching the schema. No markdown fences, ' +
        'no text before or after.',
    },
  ];
}

/* ─────────────────────── Транспорт: срок, классы сбоя, повторы ─────────────────────── */

/**
 * Свой срок вызова истёк. Отдельный тип, а не «просто AbortError»: отмена
 * пользователем и наш срок приходят одним механизмом (AbortSignal), но
 * означают разное — отмену повторять нельзя, срок повторить можно.
 *
 * Слова «timed out» в тексте — опора клиентской классификации
 * (clientErrors.ts → код 'timeout'), менять формулировку вместе с ней.
 */
export class HeLlmTimeoutError extends Error {
  /**
   * Дискриминант класса: instanceof ложен у копии модуля и у отказа,
   * восстановленного воркером из файла брошенных строк простым Error
   * (worker/hypothesisEngine.ts, FAILURE_FIELDS). Читатель — isHeLlmTimeout.
   */
  readonly heLlmTimeout = true as const;

  constructor(public readonly label: string, public readonly timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'HeLlmTimeoutError';
  }
}

/** Истёк ли свой срок попытки запроса к модели — по дискриминанту, не по тексту. */
export function isHeLlmTimeout(error: unknown): boolean {
  if (error instanceof HeLlmTimeoutError) return true;
  return (error as { heLlmTimeout?: unknown } | null)?.heLlmTimeout === true;
}

/**
 * Класс отказа транспорта. Читается ТИПОМ (instanceof + поле kind), никогда
 * регэкспом по тексту: см. шапку файла про «aborted».
 *  - transient — повтор имеет смысл (5xx, 408/425, обрыв сети, битый конверт);
 *  - rate_limit — провайдер попросил подождать (429 + Retry-After);
 *  - billing / configuration — нужен человек, повтор только сожжёт время;
 *  - permanent — прочие 4xx: тот же запрос ответит тем же.
 */
export type HeLlmFailureKind = 'transient' | 'rate_limit' | 'billing' | 'configuration' | 'permanent';

export class HeLlmHttpError extends Error {
  /** Дискриминант класса: instanceof ложен, если в процессе две копии модуля. */
  readonly heLlmFailure = true as const;

  constructor(
    message: string,
    public readonly status: number,
    public readonly kind: HeLlmFailureKind,
    /** Пауза, о которой попросил провайдер заголовком Retry-After, если попросил. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HeLlmHttpError';
  }
}

/**
 * Ответа нет или он не разобрался: соединение не установилось, оборвалось (до
 * доставки запроса ИЛИ после неё, пока провайдер генерировал ответ), тело 200
 * не дочиталось. Исполнил ли провайдер запрос и выставил ли счёт — по этому
 * классу НЕ известно; поэтому повтор внутри вызова ему положен только быстрый
 * (см. LLM_UNCERTAIN_RETRY_WINDOW_MS), а не «как будто запроса не было».
 */
export class HeLlmTransportError extends Error {
  /** Дискриминант класса: instanceof ложен, если в процессе две копии модуля. */
  readonly heLlmFailure = true as const;

  public readonly kind: HeLlmFailureKind = 'transient';
  constructor(message: string) {
    super(message);
    this.name = 'HeLlmTransportError';
  }
}

/** Что именно ответил провайдер — для политики повторов ДЖОБЫ (worker failJob). */
export interface HeLlmFailureFacts {
  kind: HeLlmFailureKind;
  /** HTTP-статус ответа; у обрыва сети статуса нет. */
  status?: number;
  /** Пауза, о которой провайдер попросил заголовком Retry-After. */
  retryAfterMs?: number;
}

const HE_LLM_FAILURE_KINDS = new Set<string>([
  'transient',
  'rate_limit',
  'billing',
  'configuration',
  'permanent',
]);

/**
 * Факты отказа транспорта, если он есть в цепочке причин ошибки, — иначе null.
 * Читает ТИП (дискриминант класса), а не текст сообщения: решение джобы
 * «припарковать до времени провайдера» / «отказать терминально» обязано
 * опираться на протокол, а не на формулировку. Цепочку `cause` проходим на
 * случай стадии, которая перебросила ошибку своим текстом.
 */
export function heLlmFailureOf(error: unknown): HeLlmFailureFacts | null {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    const candidate = e as { heLlmFailure?: unknown; kind?: unknown; status?: unknown; retryAfterMs?: unknown; cause?: unknown };
    if (candidate.heLlmFailure === true && typeof candidate.kind === 'string' && HE_LLM_FAILURE_KINDS.has(candidate.kind)) {
      return {
        kind: candidate.kind as HeLlmFailureKind,
        ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
        ...(typeof candidate.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs)
          ? { retryAfterMs: candidate.retryAfterMs }
          : {}),
      };
    }
    e = candidate.cause;
  }
  return null;
}

/** Статусы, которые чинит повтор. 429 — отдельный класс, у него своя пауза. */
const RETRYABLE_STATUSES = new Set<number>([408, 425, 500, 502, 503, 504, 529]);
/** Повторов после первой попытки (итого до 4 запросов на один вызов). */
const MAX_HTTP_RETRIES = 3;
/**
 * Окно, в котором транзиентный отказ повторяется ВНУТРИ вызова: отказ пришёл не
 * позже чем через столько мс после отправки ЭТОЙ попытки.
 *
 * Зачем окно. Транзиентный класс (5xx, 408/425, обрыв связи, недочитанное тело
 * 200) не доказывает, что провайдер запрос не исполнял: 504 шлюза или обрыв
 * сокета через восемь минут генерации hypotheses (maxTokens 32768) приходят
 * ПОСЛЕ того, как модель отработала, и такая генерация может быть оплачена.
 * Раньше её повторяли до трёх раз подряд — до четырёх оплаченных генераций на
 * одну попытку схемы. Окно ограничивает то, что повтор может оплатить второй
 * раз: отказ, пришедший за 15 с (отказ соединения, DNS, мгновенные 502/503
 * роутера, 529 перегрузки), стоит не больше 15 с работы провайдера, а штатный
 * отказ «на входе» укладывается в него с запасом. Пришедший позже не
 * повторяется здесь: он уходит наверх, как и до волны 3 (стадия либо
 * поглощает отказ элемента, либо падает и решение принимает политика попыток
 * джобы).
 *
 * 429 под окно не попадает: это отказ провайдера принять запрос (rate_limit), а
 * не исход исполненной работы, — его пауза и повтор прежние.
 */
const LLM_UNCERTAIN_RETRY_WINDOW_MS = 15_000;
/** База экспоненциального бэкоффа: 2с → 4с → 8с. */
const RETRY_BASE_MS = 2000;
/**
 * Максимум ОДНОГО ожидания перед повтором (порог на само число, не на сумму):
 * попросил провайдер дольше — отдаём слот воркеру с внятной причиной вместо
 * получаса сна в fetch. Повторов до MAX_HTTP_RETRIES, поэтому суммарно вызов
 * может проспать до 3 × этого числа — бюджет попытки (llmAttemptTimeoutMs,
 * минимум 300 000 мс) это покрывает с запасом.
 */
const MAX_RETRY_WAIT_MS = 30_000;

const LLM_DEADLINE_BASE_MS = 180_000;
const LLM_DEADLINE_PER_TOKEN_MS = 30;
const LLM_DEADLINE_MIN_MS = 300_000;
/**
 * Потолок срока ОДНОЙ попытки. Он обязан быть НЕ МЕНЬШЕ того, что просит сама
 * формула на самом дорогом вызове движка, иначе константа противоречит расчёту
 * и молча его обрезает.
 *
 * Было 900 000 мс при расчёте 180 000 + 30 × 32 768 = 1 163 040 мс для стадии
 * hypotheses (единственный вызов с maxTokens 32768): та получала 77% своего
 * бюджета, и ЗАКОННО долгая генерация обрывалась посередине ответа — платный
 * вызов выбрасывался, а за ним шли вторая попытка схемы и до трёх прогонов
 * стадии. 1 200 000 мс покрывают формулу при максимальном maxTokens движка с
 * запасом и остаются внутри границ HE_LLM_TIMEOUT_MS.
 *
 * Цена решения — в воркере: окно сторожа выводится из этого числа
 * (1,5 × → 1 800 000 мс), поэтому НАСТОЯЩЕЕ зависание стадии ловится за 30 мин
 * вместо 22,5, плюс 2 мин на аварийный выход. Порядок бюджетов при этом цел:
 * срок попытки < окно сторожа при любом maxTokens.
 */
const LLM_DEADLINE_MAX_MS = 1_200_000;
/** Границы явного HE_LLM_TIMEOUT_MS: ниже 30 с срок рубил бы штатный ответ. */
const LLM_DEADLINE_ENV_MIN_MS = 30_000;
const LLM_DEADLINE_ENV_MAX_MS = 1_800_000;
/** Попыток схемы на один вызов (первая + повтор с фидбэком). */
const SCHEMA_ATTEMPTS = 2;

/** Про отклонённый HE_LLM_TIMEOUT_MS достаточно одной строки на процесс. */
let rejectedAttemptMsLogged = false;

/**
 * Явный срок из окружения, если он задан и в границах.
 *
 * Отклонённое значение больше НЕ молчит. Раньше опечатка («30» вместо «30000»,
 * «5m», значение вне границ) просто игнорировалась, а стартовая строка воркера
 * печатала действующий срок и выведенное из него окно сторожа так, будто
 * переменную приняли: оператор был уверен, что бюджеты изменил, и продолжал
 * искать причину в другом месте. Теперь отказ виден там же, где виден срок.
 */
function configuredAttemptMs(): number | null {
  const raw = (process.env.HE_LLM_TIMEOUT_MS ?? '').trim();
  if (!raw) return null;
  const configured = Number(raw);
  if (
    Number.isFinite(configured) &&
    configured >= LLM_DEADLINE_ENV_MIN_MS &&
    configured <= LLM_DEADLINE_ENV_MAX_MS
  ) {
    return configured;
  }
  if (!rejectedAttemptMsLogged) {
    rejectedAttemptMsLogged = true;
    llmLog(
      `[he-llm] HE_LLM_TIMEOUT_MS='${raw}' ОТКЛОНЁН (допустимо ` +
        `${LLM_DEADLINE_ENV_MIN_MS}…${LLM_DEADLINE_ENV_MAX_MS} мс) — действует расчёт срока по maxTokens`,
    );
  }
  return null;
}

/**
 * Срок на ОДНУ попытку запроса: база + запас на maxTokens, не меньше 300 с и не
 * больше 1 200 с; явный HE_LLM_TIMEOUT_MS перебивает расчёт.
 *
 * Считать от maxTokens обязательно: стадия hypotheses просит у opus 32768
 * токенов (stages/hypotheses.ts:230), цепочки писем — 16384, и фиксированные
 * 300 с обрезали бы ШТАТНЫЙ ответ RU-инструмента специалистов, то есть лечение
 * зависания обернулось бы поломкой рабочего прогона. Нижняя граница выбрана
 * равной сроку, который на тех же моделях уже работает в соседнем движке.
 *
 * ПОПЫТКА, а не весь вызов: один срок на оба прохода схемы означал, что
 * медленный первый проход оставлял повтору огрызок бюджета и тот обрывался
 * посередине генерации — платный вызов, выброшенный из-за чужой медлительности.
 * Вызов при этом остаётся ограниченным: попыток ровно SCHEMA_ATTEMPTS, у каждой
 * свой срок, то есть весь вызов ≤ SCHEMA_ATTEMPTS × срок попытки.
 */
function llmAttemptTimeoutMs(maxTokens: number): number {
  const configured = configuredAttemptMs();
  if (configured !== null) return configured;
  const budget = LLM_DEADLINE_BASE_MS + maxTokens * LLM_DEADLINE_PER_TOKEN_MS;
  return Math.min(LLM_DEADLINE_MAX_MS, Math.max(LLM_DEADLINE_MIN_MS, budget));
}

/**
 * Самое долгое ЗАКОННОЕ молчание одного запроса к модели — потолок
 * llmAttemptTimeoutMs при любом maxTokens, включая перекрышку из окружения.
 *
 * Читатель — сторож простоя стадии в воркере: окно «стадия зависла» обязано
 * быть заметно БОЛЬШЕ этого числа, иначе здоровая генерация объявляется
 * зависанием, прерывание считается бесплатным и самый дорогой вызов проекта
 * оплачивается заново (ровно этот баг волна и лечит). Поэтому порядок бюджетов
 * задаётся здесь, а не двумя константами в двух файлах: HE_LLM_TIMEOUT_MS
 * перевернуть его не может — окно следует за сроком, а не наоборот.
 */
export function heLlmMaxAttemptMs(): number {
  return configuredAttemptMs() ?? LLM_DEADLINE_MAX_MS;
}

/**
 * Срок ОДНОЙ попытки запроса — включая её внутренние транспортные повторы. Копия
 * withVeDeadline соседнего движка (не импорт: архитектурный тест
 * tests/architecture/verticalEngineV2Isolation.test.ts запрещает движку V1
 * импортировать модули V2).
 *
 * Зачем: до этого срока молчащий сокет держал стадию БЕСКОНЕЧНО. Воркер
 * движка single-flight, heartbeat тикает независимым setInterval
 * (worker/_shared.ts), а resetStuckJobs отрабатывает только на старте
 * процесса — то есть один зависший запрос к роутеру останавливал ВСЕ задачи
 * движка до ручного рестарта, и healthcheck при этом оставался зелёным.
 *
 * Отклоняем промис сами, даже если fetch проигнорирует сигнал; поздний
 * результат отбрасывается.
 *
 * Рядом живёт operationDeadline.ts — тот же механизм для ОДНОЙ транспортной
 * операции стадии (чтение сайта, поиск). Двойник умышленный: там срок бросает
 * `HeOperationTimeoutError`, который стадии читают как «хост молчит, идём
 * дальше», и вызов модели под тем же классом стадия приняла бы за мёртвую
 * страницу. Здесь свой класс — `HeLlmTimeoutError`.
 */
async function withLlmDeadline<T>(
  label: string,
  timeoutMs: number,
  parent: AbortSignal | null | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('LLM call timeout must be finite and positive');
  }
  const controller = new AbortController();
  const { signal } = controller;
  const onParentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new HeLlmTimeoutError(label, timeoutMs)), timeoutMs);
  try {
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    });
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Retry-After: секунды или дата. Отрицательные и абсурдные значения — мимо. */
function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const until = /^\d+(?:\.\d+)?$/.test(text) ? now + Math.ceil(Number(text) * 1000) : Date.parse(text);
  return Number.isFinite(until) && until <= 8.64e15 && until >= now ? until - now : undefined;
}

/** Пауза, прерываемая отменой задачи и своим сроком. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Статусы, у которых тело ответа ВПРАВЕ уточнить класс: провайдер отвечает
 * «insufficient credits» и под 400, и под 429, а «invalid key» — под 401/403.
 * Всё остальное классифицируется одним статусом.
 */
const BODY_CLASSIFIED_STATUSES = new Set<number>([400, 401, 402, 403, 409, 422, 429]);

/**
 * Класс отказа по ответу роутера. Первичный признак — СТАТУС, структурный факт
 * протокола.
 *
 * Транзиентные статусы решаются ПЕРВЫМИ и телу не отдаются: 5xx/408/425 — это
 * «сервер не справился», и если в его теле случайно окажется «invalid key»
 * (эхо чужого апстрима, отладочный дамп, HTML-заглушка балансировщика), повтор
 * терять нельзя, а клиенту нельзя показывать ошибку конфигурации там, где
 * ничего не сломано. Тело смотрим только у статусов, которые ДЕЙСТВИТЕЛЬНО
 * несут биллинг и авторизацию, и только чтобы расширить два неповторяемых
 * класса. Предикаты берём из clientErrors.ts — они там и выделены отдельно под
 * политику ретраев.
 */
function httpFailureKind(status: number, body: string): HeLlmFailureKind {
  if (RETRYABLE_STATUSES.has(status) || status >= 500) return 'transient';
  if (BODY_CLASSIFIED_STATUSES.has(status)) {
    const text = `Requesty ${status}: ${body}`;
    if (isHeProviderBillingError(text)) return 'billing';
    if (isHeProviderConfigurationError(text)) return 'configuration';
  }
  if (status === 429) return 'rate_limit';
  return 'permanent';
}

/**
 * Сколько ждать перед повтором — или null, если повторять нельзя.
 * 429: ждём ровно столько, сколько попросил провайдер, но не дольше
 * MAX_RETRY_WAIT_MS; больше — честный отказ, решение за джобой.
 * Транзиентный отказ, пришедший позже LLM_UNCERTAIN_RETRY_WINDOW_MS после
 * отправки попытки, не повторяется: провайдер мог его уже исполнить и выставить
 * счёт.
 */
function retryWaitMs(
  failure: HeLlmHttpError | HeLlmTransportError,
  attempt: number,
  elapsedMs: number,
): number | null {
  if (failure.kind !== 'transient' && failure.kind !== 'rate_limit') return null;
  if (attempt >= MAX_HTTP_RETRIES) return null;
  if (failure.kind === 'transient' && elapsedMs > LLM_UNCERTAIN_RETRY_WINDOW_MS) return null;
  const asked = failure instanceof HeLlmHttpError ? failure.retryAfterMs : undefined;
  const wait = Math.max(RETRY_BASE_MS * 2 ** attempt, asked ?? 0);
  return wait > MAX_RETRY_WAIT_MS ? null : wait;
}

/** Отмена задачи и свой срок — не сбои провайдера: пробрасываем как есть. */
function throwIfInterrupted(signal: AbortSignal, err: unknown): void {
  if (signal.aborted) throw signal.reason ?? err;
  if (err instanceof Error && err.name === 'AbortError') throw err;
}

async function rawCall(
  messages: LLMMessage[],
  model: string,
  maxTokens: number,
  jsonMode: boolean,
  signal: AbortSignal,
  /** Язык подсказки json_object-режима (jsonHintLanguage); без JSON-режима не читается. */
  hintLanguage: HeJsonHintLanguage = 'ru',
  maxRetries: number = MAX_HTTP_RETRIES,
): Promise<{ text: string; response: RequestyResponse }> {
  // Ключ читаем ДО цикла: пробел в конфигурации повтором не лечится, а сообщение
  // с именем env-переменной клиентский маппинг узнаёт как 'configuration'.
  const apiKey = getApiKey();
  const body = JSON.stringify({
    model,
    messages: jsonMode ? withJsonModeHint(messages, hintLanguage) : messages,
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let failure: HeLlmHttpError | HeLlmTransportError;
    // Отсчёт от отправки ЭТОЙ попытки (пауза бэкоффа сюда не входит): по нему
    // retryWaitMs отличает отказ «на входе» от отказа после генерации.
    const sentAt = Date.now();
    // Код ответа этой попытки — для строки журнала расхода (journalRequestyCall).
    let httpStatus: number | undefined;
    try {
      // Признак жизни ДО запроса и сразу ПОСЛЕ ответа: между ними идёт самое
      // длинное законное молчание движка — генерация ответа моделью. Отметка на
      // каждой попытке, включая транспортные повторы, — именно этим сторож
      // простоя отличает работающий платный вызов от зависшей стадии.
      noteLlmActivity();
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
        signal,
      });
      httpStatus = res.status;
      noteLlmActivity();
      if (res.ok) {
        // Конверт проверяем, и у каждого его изъяна СВОЙ класс. Раньше оба
        // уезжали безымянным `new Error(...)` в catch ниже, тот красил всё в
        // transient, и структурно не тот ответ повторялся тремя новыми ПЛАТНЫМИ
        // запросами. Решение о повторе снова принимает класс, а не catch-all.
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch (e) {
          // Тело 200 не доехало целиком (обрыв в середине ответа): ответа как
          // будто не было — повтор уместен, класс transient. Текст без второго
          // префикса: свой типизированный класс catch ниже не перекрашивает.
          throw new HeLlmTransportError(
            `Requesty transport: тело ответа 200 не разобралось (${e instanceof Error ? e.message : String(e)})`,
          );
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          // Тело разобралось, но это НЕ конверт чата (массив, строка, null):
          // тот же запрос ответит тем же, а каждый повтор — новый платный
          // вызов, поэтому класс permanent. Возможную оплату называем в тексте:
          // usage из такого ответа не прочитать, и в cost_usd этот вызов не
          // попадёт вообще никак.
          throw new HeLlmHttpError(
            `Requesty ${res.status}: ответ не похож на JSON-конверт чата (вызов мог быть оплачен)`,
            res.status,
            'permanent',
          );
        }
        const response = parsed as RequestyResponse;
        // Ответ принят — строка журнала с токенами и ценой (до решения
        // вызывающего о годности ответа: оплачен он в любом случае).
        journalRequestyCall(model, 'ok', httpStatus, response);
        return { text: response.choices?.[0]?.message?.content ?? '', response };
      }
      const text = await res.text();
      noteLlmActivity();
      const kind = httpFailureKind(res.status, text);
      failure = new HeLlmHttpError(
        `Requesty ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        kind,
        // Retry-After провайдер присылает и с 503 (окно перегрузки), не только
        // с 429; для неповторяемых классов заголовок смысла не имеет.
        kind === 'rate_limit' || kind === 'transient'
          ? retryAfterMs(res.headers.get('retry-after'))
          : undefined,
      );
      journalRequestyCall(model, 'failed', httpStatus);
    } catch (err) {
      // Пригодного ответа нет: отмена, свой срок, обрыв, тело 200 не
      // дочиталось или не конверт чата — исполнен ли запрос, неизвестно.
      journalRequestyCall(model, 'aborted', httpStatus);
      throwIfInterrupted(signal, err);
      // Уже классифицированный отказ (конверт 200 выше) сохраняем как есть:
      // иначе класс снова назначал бы catch-all, и «тот же запрос ответит тем
      // же» опять повторялось бы трижды за деньги.
      failure =
        err instanceof HeLlmHttpError || err instanceof HeLlmTransportError
          ? err
          : new HeLlmTransportError(
              `Requesty transport: ${err instanceof Error ? err.message : String(err)}`,
            );
    }

    const elapsedMs = Date.now() - sentAt;
    const waitMs = attempt >= maxRetries ? null : retryWaitMs(failure, attempt, elapsedMs);
    if (waitMs === null) {
      // Транзиент, которому повтор не положен только из-за окна, — в лог: иначе
      // по логу не отличить «повторы кончились» от «повтор мог оплатить
      // генерацию второй раз».
      if (failure.kind === 'transient' && attempt < maxRetries && elapsedMs > LLM_UNCERTAIN_RETRY_WINDOW_MS) {
        llmLog(
          `[he-llm] ${model}: ${failure.kind} (${failure.message.slice(0, 160)}) через ${elapsedMs} мс после отправки — ` +
            `внутри вызова не повторяем: провайдер мог исполнить запрос и выставить счёт`,
        );
      }
      throw failure;
    }
    // Строка получает личность прогона (id воркера, джобы, проекта, стадия) из
    // канала активной джобы: в общем логе контейнера иначе не видно, чей это
    // повтор. Вне воркера — прежний console.warn процесса.
    llmLog(
      `[he-llm] ${model}: ${failure.kind} (${failure.message.slice(0, 160)}) — ` +
        `повтор ${attempt + 1}/${maxRetries} через ${waitMs} мс`,
    );
    await sleep(waitMs, signal);
  }
}

function usageOf(response: RequestyResponse): {
  promptTokens: number;
  completionTokens: number;
  tokensUsed: number;
  /** Цена вызова от роутера, если он её вернул: нужна моделям без своей ставки. */
  reportedCostUsd?: number;
} {
  const usage = response.usage || {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cost = usage.cost;
  return {
    promptTokens,
    completionTokens,
    tokensUsed: usage.total_tokens ?? promptTokens + completionTokens,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { reportedCostUsd: cost } : {}),
  };
}

/**
 * Ремонт JSON, обрезанного по max_tokens: отрезаем хвост до конца последней
 * целой структуры и докрываем скобки вариантами `}`, `]}`, `]}]`, `"}]`.
 * Возвращает распарсенное значение или null (тогда идём в обычный retry).
 * Семантическую валидность результата дальше проверяет zod-схема вызова.
 */
export function tryRepairTruncatedJson(text: string): unknown | null {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  // Сначала предпочтительный путь: отрезаем хвост до конца последней ЦЕЛОЙ
  // структуры — незавершённые объекты отбрасываем, а не «закрываем» их.
  const suffixes = ['', '}', ']}', ']}]', '"}]', '"}', '"]}'];
  for (let end = t.length; end > 0; end--) {
    const ch = t[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    const head = t.slice(0, end);
    for (const suffix of suffixes) {
      try {
        return JSON.parse(head + suffix);
      } catch {
        // пробуем следующий вариант закрытия
      }
    }
  }
  // Fallback: обрезка посередине строки/токена без единой закрывающей скобки —
  // докрываем строку и/или структуру целиком.
  const tailSuffixes = ['', '"', '}', ']', '"}', '"}]', '"}]}', ']}', ']}]'];
  for (const suffix of tailSuffixes) {
    try {
      return JSON.parse(t + suffix);
    } catch {
      // следующий вариант
    }
  }
  return null;
}

/**
 * Один LLM-вызов с response_format=json_object + Zod-валидация ответа.
 * При невалидном JSON — 1 retry с system-фидбэком об ошибке. Если и второй
 * раз невалидно — бросает LLMValidationError (воркер помечает job failed).
 *
 * У КАЖДОЙ попытки схемы свой полный срок (llmAttemptTimeoutMs), внутри него —
 * транспортные повторы этой попытки. Весь вызов ограничен структурно: попыток
 * ровно SCHEMA_ATTEMPTS, то есть ≤ SCHEMA_ATTEMPTS × срок попытки.
 */
export async function callLLMWithSchema<T>(
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts: HeLlmSchemaCallOptions,
): Promise<LLMResult<T>> {
  const maxTokens = opts.maxTokens ?? 4096;
  // Канал читаем ОДИН раз, в начале вызова (см. HeActiveJobChannel.onSpend).
  const job = activeJob;
  // Правило учёта — тоже один раз на вызов (см. шапку файла).
  const eng = heLlmEngAccounting(opts.market);
  return callLLMWithSchemaAttempts(
    messages,
    schema,
    opts,
    maxTokens,
    job?.signal ?? null,
    eng ? job?.onSpend : undefined,
    eng,
  );
}

async function callLLMWithSchemaAttempts<T>(
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts: HeLlmSchemaCallOptions,
  maxTokens: number,
  parent: AbortSignal | null,
  onSpend: ((spend: HeLlmSpend) => void) | undefined,
  /** Правило учёта ENG (heLlmEngAccounting); false — RU-учёт, как до порта. */
  eng: boolean,
): Promise<LLMResult<T>> {
  const attempts: Array<{
    text: string;
    error?: string;
    /** truncated — ответ обрезан по max_tokens; фидбэк повтора у него свой. */
    kind: 'truncated' | 'json_syntax' | 'schema';
    zodError?: z.ZodError;
  }> = [];
  const attemptTimeoutMs = llmAttemptTimeoutMs(maxTokens);
  /**
   * Расход ОТБРОШЕННЫХ попыток. Провайдер выставил счёт за каждый ответ, в том
   * числе за тот, который не прошёл схему или приехал обрезанным, — а учёт
   * читал usage только удачной попытки, и вторая оплата была невидима в
   * cost_usd. Копим и добавляем к итогу: переплата обязана быть видна там же,
   * где считается стоимость прогона. Только по правилу ENG; у RU-проекта
   * остаётся нулём (учёт как до порта — см. keepDiscardedUsage).
   */
  const discarded = { tokensUsed: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  // Язык служебных сообщений — по ИСХОДНЫМ сообщениям, один раз на вызов:
  // переигранный ответ и фидбэк повтора на него влиять не должны.
  const hintLanguage = jsonHintLanguage(messages);

  for (let attempt = 0; attempt < SCHEMA_ATTEMPTS; attempt++) {
    parent?.throwIfAborted();
    const currentMessages: LLMMessage[] = [...messages];
    const previous = attempt > 0 ? attempts[0] : undefined;
    if (previous && hintLanguage === 'en') {
      currentMessages.push(...englishSchemaRetryMessages(previous));
    } else if (previous) {
      // Обрубок в истории учит модель вернуть ровно тот же обрубок (а срез до
      // 2000 символов делает обрубком даже целый ответ), поэтому при усечении
      // предыдущий ответ не переигрываем вовсе и просим полный результат.
      if (previous.kind !== 'truncated') {
        currentMessages.push({ role: 'assistant', content: previous.text.slice(0, 2000) });
      }
      currentMessages.push({
        role: 'user',
        content: previous.kind === 'truncated'
          ? 'Твой предыдущий ответ не поместился в лимит и был обрезан. Верни ПОЛНЫЙ результат по исходному ' +
            'запросу: все элементы списка, строго валидный JSON по схеме, без markdown-фенсов и текста до/после. ' +
            'Сокращай значения полей, а не список.'
          : `Твой предыдущий ответ не прошёл валидацию JSON-схемы. Ошибка:\n` +
            `${previous.error}\n\n` +
            `Верни валидный JSON строго по схеме. Никаких markdown-фенсов, никакого текста до/после.`,
      });
    }

    // Свой полный срок на КАЖДУЮ попытку: медленный первый проход больше не
    // оставляет повтору огрызок бюджета (иначе повтор режется посередине
    // генерации — платный ответ выброшен из-за чужой медлительности).
    const { text, response } = await withLlmDeadline(
      `LLM request ${attempt + 1}/${SCHEMA_ATTEMPTS}`,
      attemptTimeoutMs,
      parent,
      (signal) => rawCall(currentMessages, opts.model, maxTokens, true, signal, hintLanguage),
    );
    const { promptTokens, completionTokens, tokensUsed, reportedCostUsd } = usageOf(response);
    const costUsd = eng
      ? costOfCall(opts.model, promptTokens, completionTokens, reportedCostUsd)
      : ruCostOfCall(opts.model, promptTokens, completionTokens);
    // Ответ оплачен — воркер узнаёт об этом сразу, до решения о его годности:
    // если следующая попытка бросит (транспорт, срок, прерывание), расход
    // этой иначе не дошёл бы никуда (discarded живёт только до return).
    // У RU-проекта onSpend нет (см. callLLMWithSchema).
    onSpend?.({ tokensUsed, costUsd });
    /**
     * Отброшенная попытка тоже оплачена: копим её расход (см. discarded).
     * Только по правилу ENG: RU-учёт, как до порта, берёт расход одной
     * принятой попытки и об отброшенной не пишет.
     */
    const keepDiscardedUsage = () => {
      if (!eng) return;
      discarded.tokensUsed += tokensUsed;
      discarded.promptTokens += promptTokens;
      discarded.completionTokens += completionTokens;
      discarded.costUsd += costUsd;
      llmLog(
        `[he-llm] ${opts.model}: попытка ${attempt + 1}/${SCHEMA_ATTEMPTS} отброшена, ` +
          `оплачена (+${tokensUsed} tok, $${costUsd.toFixed(6)}): расход идёт в итог вызова, ` +
          `а если вызов откажет — в учёт прогона воркера`,
      );
    };

    // Усечённый ответ там, где важна полнота списка: ремонт ниже сделал бы из
    // 12 строк из 40 «уверенный» короткий ответ, и потребитель не узнал бы,
    // что список не полон. Повторяем, а не спасаем кусок.
    const finishReason = response.choices?.[0]?.finish_reason;
    if (opts.requireCompleteJson && finishReason === 'length') {
      attempts.push({ text, kind: 'truncated', error: 'ответ обрезан по max_tokens (finish_reason=length)' });
      keepDiscardedUsage();
      continue;
    }

    // strip markdown fences if модель их всё-таки добавила
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Ремонт усечённого JSON: модель упёрлась в max_tokens посередине
      // массива объектов. Обрезаем до последней целой структуры и закрываем
      // скобки — спасаем то, что успело сгенерироваться, вместо жёсткого фейла.
      // При requireCompleteJson ремонт запрещён: см. комментарий выше.
      parsed = opts.requireCompleteJson ? null : tryRepairTruncatedJson(cleaned);
      if (parsed === null) {
        attempts.push({
          text,
          kind: opts.requireCompleteJson ? 'truncated' : 'json_syntax',
          error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        keepDiscardedUsage();
        continue;
      }
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      attempts.push({
        text,
        kind: 'schema',
        zodError: validated.error,
        error: JSON.stringify(validated.error.format()).slice(0, 800),
      });
      keepDiscardedUsage();
      continue;
    }

    return {
      data: validated.data,
      tokensUsed: tokensUsed + discarded.tokensUsed,
      promptTokens: promptTokens + discarded.promptTokens,
      completionTokens: completionTokens + discarded.completionTokens,
      costUsd: costUsd + discarded.costUsd,
      rawResponse: response,
    };
  }

  const last = attempts[attempts.length - 1]!;
  throw new LLMValidationError(
    (last.kind === 'truncated'
      ? `LLM дважды вернул неполный ответ: ${last.error}`
      : `LLM вернул невалидный JSON дважды: ${last.error}`) +
      // Оплаченное и выброшенное — в тексте отказа: стадия этот расход уже не
      // вернёт (usage приезжает только с результатом), но невидимым он быть
      // не должен. Только по правилу ENG: у RU-проекта текст отказа (он же
      // he_jobs.error) прежний, без суффикса.
      (eng ? ` [оплачено и отброшено: ${discarded.tokensUsed} tok, $${discarded.costUsd.toFixed(6)}]` : ''),
    last.text,
    // Причина уровня схемы нужна стадии: по путям она отличает «список пуст»
    // от «элемент кривой» (llmValidationIssuePaths).
    last.zodError,
  );
}

/**
 * Свободный текст без json_object — для генерации цепочек писем и финальных
 * шаблонов (парсинг маркерами ---LETTER N--- через letterParser).
 * Без retry: валидность текста проверяет вызывающая стадия.
 */
export async function callLLMText(
  messages: LLMMessage[],
  opts: HeLlmTextCallOptions,
): Promise<LLMTextResult> {
  const maxTokens = opts.maxTokens ?? 8192;
  // Канал читаем ОДИН раз, в начале вызова (см. HeActiveJobChannel.onSpend).
  const job = activeJob;
  // Правило учёта — тоже один раз на вызов (см. шапку файла).
  const eng = heLlmEngAccounting(opts.market);
  // Попытка одна (повтора схемы у свободного текста нет), поэтому срок попытки
  // ограничивает и весь вызов.
  const { text, response } = await withLlmDeadline(
    'LLM request',
    llmAttemptTimeoutMs(maxTokens),
    job?.signal ?? null,
    (signal) => rawCall(messages, opts.model, maxTokens, opts.jsonMode === true, signal,
      opts.jsonMode === true ? jsonHintLanguage(messages) : undefined,
      opts.transportRetries === 0 ? 0 : MAX_HTTP_RETRIES),
  );
  const { promptTokens, completionTokens, tokensUsed, reportedCostUsd } = usageOf(response);
  const costUsd = eng
    ? costOfCall(opts.model, promptTokens, completionTokens, reportedCostUsd)
    : ruCostOfCall(opts.model, promptTokens, completionTokens);
  // Канал расхода — только по правилу ENG (у RU-проекта молчит, как до порта).
  if (eng) job?.onSpend?.({ tokensUsed, costUsd });
  return {
    text: text.trim(),
    tokensUsed,
    promptTokens,
    completionTokens,
    costUsd,
    rawResponse: response,
    finishReason: response.choices?.[0]?.finish_reason,
  };
}

/**
 * callLLMText с ОПЦИОНАЛЬНОЙ запасной моделью. По умолчанию fallback НЕТ:
 * решение владельца — лучше честная ошибка, чем тихая подмена модели.
 * Включается только явно: opts.fallbackModel или env HE_MODEL_CHAIN_FALLBACK.
 * Условие повтора: основная вернула пустой/короткий текст (< minChars)
 * или finish_reason='content_filter'.
 */
export async function callLLMTextWithFallback(
  messages: LLMMessage[],
  opts: HeLlmTextCallOptions,
): Promise<LLMTextResult> {
  const minChars = opts.minChars ?? 20;
  const fallbackModel = (opts.fallbackModel ?? process.env.HE_MODEL_CHAIN_FALLBACK ?? '').trim();
  const first = await callLLMText(messages, opts);
  const refused = first.finishReason === 'content_filter' || first.text.length < minChars;
  if (!refused || !fallbackModel || fallbackModel === opts.model) return first;
  opts.log?.(`[llm] ${opts.model}: отказ или пустой ответ (finish=${first.finishReason ?? 'n/a'}, len=${first.text.length}) — повтор на ${fallbackModel}`);
  const second = await callLLMText(messages, { ...opts, model: fallbackModel });
  // Суммируем стоимость обоих вызовов, текст — от успешного.
  return {
    ...second,
    tokensUsed: first.tokensUsed + second.tokensUsed,
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    costUsd: first.costUsd + second.costUsd,
  };
}
