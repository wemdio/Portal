/**
 * LLM-хелпер «Движка вертикалей». Копия паттерна salesAiAnalysis/llm.ts:
 * Requesty router (OpenAI-compatible), response_format: json_object +
 * Zod-валидация + 1 retry с фидбэком об ошибке, учёт токенов/стоимости.
 *
 * Отличия от salesAiAnalysis:
 *  - свой ключ: OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (fallback OPENROUTER_BRIEF_API_KEY);
 *  - четыре роли моделей (см. getHeModel): research / chain / bulk / gate;
 *  - дополнительный callLLMText — свободный текст без json_object
 *    (цепочки писем парсятся маркерами ---LETTER N---, а не схемой).
 *
 * Цены (USD/M токенов) — по прайсу Requesty на момент написания; при смене
 * моделей обновить MODEL_PRICES. Фолбэка «считать по самой дорогой» больше нет:
 * он завышал самый массовый вызов движка в ~33 раза. Модель без ставки прогон
 * не останавливает: расход берётся из usage.cost роутера, а сам пробел в
 * таблице виден в логе (см. costOfCall).
 */

import { z } from 'zod';

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
  'gpt-5.5':                        { in: 4.5, out: 27.0 },
  'openai/gpt-5.5':                 { in: 4.5, out: 27.0 },
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
 */
function noteUnpriced(model: string, reason: string, detail: string): void {
  const key = `${model}|${reason}`;
  if (unpricedLogged.has(key)) return;
  unpricedLogged.add(key);
  console.error(`[he-llm] нет ставки в MODEL_PRICES для модели '${model}': ${detail}`);
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_HYPOTHESIS_ENGINE_API_KEY не задан (и нет fallback OPENROUTER_BRIEF_API_KEY)');
  }
  return key;
}

/**
 * Стоимость вызова. Порядок: ставка из MODEL_PRICES (штатный путь, цифры не
 * меняются) → фактический `usage.cost` роутера → 0 с записью в лог.
 *
 * Ставки может не быть у модели из env или из явного opts.model, и бросать
 * здесь нельзя: к моменту подсчёта вызов уже оплачен, стадия упала бы ПОСЛЕ
 * успешного ответа модели — пробел в бухгалтерии не повод останавливать
 * работающий платный прогон. Requesty отдаёт свою цену вызова в usage.cost
 * (в VE2 это и есть источник аудита расхода) — это точнее любой таблицы, и
 * ставку «самой дорогой» модели не выдумываем ни при каких условиях. Если и
 * usage.cost нет — вклад нулевой (сумму складывают в stages/shared.ts и
 * прибавляют к numeric-колонке, NaN сломал бы её), но не молча: см. noteUnpriced.
 */
function costOfCall(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reportedCostUsd?: number,
): number {
  const p = lookupPrices(model);
  if (p) return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
  if (reportedCostUsd !== undefined) {
    noteUnpriced(model, 'router', `расход взят из usage.cost роутера ($${reportedCostUsd}) — допишите ставку в hypothesisEngine/llm.ts`);
    return reportedCostUsd;
  }
  noteUnpriced(model, 'missing', 'и роутер не вернул usage.cost — расход этого вызова НЕ попал в cost_usd, допишите ставку в hypothesisEngine/llm.ts');
  return 0;
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
        `расход ляжет на usage.cost роутера, а без него в ноль — допишите ставку в hypothesisEngine/llm.ts`,
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
 * AbortSignal активной джобы воркера. Воркер single-flight (handleJob
 * выполняет строго одну джобу за раз), поэтому сигнал — модульный:
 * worker/hypothesisEngine.ts ставит его перед runHeStage и снимает после.
 * Отмена задачи (he_jobs.status='cancelled') через сигнал обрывает текущий
 * HTTP-запрос к LLM сразу, а не по окончании стадии — деньги не догорают.
 * Вне воркера (API-роуты) сигнала нет — поведение прежнее.
 */
let activeJobSignal: AbortSignal | null = null;

export function setHeActiveJobSignal(signal: AbortSignal | null): void {
  activeJobSignal = signal;
}

/**
 * json_object-режим отвечает 400, если слово «json» не встречается ни в одном
 * сообщении. Промпты в prompts/ формат упоминают, а инлайновые (system досье
 * собирается в stages/dossier.ts) — нет, и такая стадия падала на каждом
 * прогоне. Подсказку добавляем здесь, а не в каждом промпте.
 */
function withJsonModeHint(messages: LLMMessage[]): LLMMessage[] {
  if (messages.some((m) => /json/i.test(m.content))) return messages;
  return [
    ...messages,
    {
      role: 'user',
      content:
        'Верни ответ строго как валидный JSON по схеме: без markdown-фенсов и без текста до/после.',
    },
  ];
}

async function rawCall(
  messages: LLMMessage[],
  model: string,
  maxTokens: number,
  jsonMode: boolean,
): Promise<{ text: string; response: RequestyResponse }> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiKey()}` },
    body: JSON.stringify({
      model,
      messages: jsonMode ? withJsonModeHint(messages) : messages,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    ...(activeJobSignal ? { signal: activeJobSignal } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Requesty ${res.status}: ${text.slice(0, 300)}`);
  }
  const response = (await res.json()) as RequestyResponse;
  const text = response.choices?.[0]?.message?.content ?? '';
  return { text, response };
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
 */
export async function callLLMWithSchema<T>(
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts: { model: string; maxTokens?: number },
): Promise<LLMResult<T>> {
  const maxTokens = opts.maxTokens ?? 4096;

  const attempts: Array<{ text: string; error?: string }> = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const currentMessages: LLMMessage[] = [...messages];
    if (attempt > 0 && attempts[0]) {
      currentMessages.push(
        { role: 'assistant', content: attempts[0].text.slice(0, 2000) },
        { role: 'user', content:
          `Твой предыдущий ответ не прошёл валидацию JSON-схемы. Ошибка:\n` +
          `${attempts[0].error}\n\n` +
          `Верни валидный JSON строго по схеме. Никаких markdown-фенсов, никакого текста до/после.`,
        },
      );
    }

    const { text, response } = await rawCall(currentMessages, opts.model, maxTokens, true);
    const { promptTokens, completionTokens, tokensUsed, reportedCostUsd } = usageOf(response);

    // strip markdown fences if модель их всё-таки добавила
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Ремонт усечённого JSON: модель упёрлась в max_tokens посередине
      // массива объектов. Обрезаем до последней целой структуры и закрываем
      // скобки — спасаем то, что успело сгенерироваться, вместо жёсткого фейла.
      parsed = tryRepairTruncatedJson(cleaned);
      if (parsed === null) {
        attempts.push({ text, error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      attempts.push({
        text,
        error: JSON.stringify(validated.error.format()).slice(0, 800),
      });
      continue;
    }

    return {
      data: validated.data,
      tokensUsed,
      promptTokens,
      completionTokens,
      costUsd: costOfCall(opts.model, promptTokens, completionTokens, reportedCostUsd),
      rawResponse: response,
    };
  }

  const last = attempts[attempts.length - 1]!;
  throw new LLMValidationError(
    `LLM вернул невалидный JSON дважды: ${last.error}`,
    last.text,
  );
}

/**
 * Свободный текст без json_object — для генерации цепочек писем и финальных
 * шаблонов (парсинг маркерами ---LETTER N--- через letterParser).
 * Без retry: валидность текста проверяет вызывающая стадия.
 */
export async function callLLMText(
  messages: LLMMessage[],
  opts: { model: string; maxTokens?: number },
): Promise<LLMTextResult> {
  const maxTokens = opts.maxTokens ?? 8192;
  const { text, response } = await rawCall(messages, opts.model, maxTokens, false);
  const { promptTokens, completionTokens, tokensUsed, reportedCostUsd } = usageOf(response);
  return {
    text: text.trim(),
    tokensUsed,
    promptTokens,
    completionTokens,
    costUsd: costOfCall(opts.model, promptTokens, completionTokens, reportedCostUsd),
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
  opts: { model: string; maxTokens?: number; fallbackModel?: string; minChars?: number; log?: (msg: string) => void },
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
