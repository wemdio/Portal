/**
 * LLM-хелпер «Движка вертикалей». Копия паттерна salesAiAnalysis/llm.ts:
 * Requesty router (OpenAI-compatible), json_object (opt-in strict json_schema) +
 * Zod-валидация + 1 retry с фидбэком об ошибке, учёт токенов/стоимости.
 *
 * Отличия от salesAiAnalysis:
 *  - свой ключ: OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (fallback OPENROUTER_BRIEF_API_KEY);
 *  - отдельные роли моделей (см. getVeModel), включая проверку релевантности;
 *  - дополнительный callLLMText — свободный текст без json_object
 *    (цепочки писем парсятся маркерами ---LETTER N---, а не схемой).
 *
 * Стоимость из usage.cost — приоритетный источник. Известные тарифы дают
 * только запасную оценку; отсутствие usage/тарифа остаётся неизвестным
 * расходом в отдельном журнале, а не выдуманной ценой другой модели.
 */

import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withVeDeadline } from './operationDeadline';
import { beginProviderUsage, getProviderUsageScope } from '@/lib/providerUsage';
import { veLlmRateLimit } from './llmRateLimit';
import { isVeProviderBillingError } from './collectionErrors';

const API_URL = 'https://router.requesty.ai/v1/chat/completions';

interface RequestyResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number;
    prompt_tokens_details?: { cached_tokens?: number } };
}

type ModelPrices = { in: number; out: number; cached?: number };
const MODEL_PRICES: Record<string, ModelPrices> = {
  // Requesty /v1/models, 2026-09-08. Reserve estimates include its 5% markup.
  'openai/gpt-4o-mini': { in: 0.15, out: 0.60, cached: 0.075 },
  'gpt-4o-mini': { in: 0.15, out: 0.60, cached: 0.075 },
  'openai/gpt-5-mini': { in: 0.25, out: 2.0, cached: 0.025 },
  'gpt-5-mini': { in: 0.25, out: 2.0, cached: 0.025 },
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
  'gpt-5.5':                        { in: 5.0, out: 30.0 },
  'openai/gpt-5.5':                 { in: 5.0, out: 30.0 },
  'gemini-3.1-pro-preview':         { in: 1.8, out: 10.8 },
  'google/gemini-3.1-pro-preview':  { in: 1.8, out: 10.8 },
  // Основная модель сбора. Ставка снята с продового журнала 20.09.2026
  // (26 619 оплаченных вызовов, регрессия по входным токенам, r=0.99):
  // $0.099 за миллион входных с наценкой Requesty. Без этой строки
  // estimatedCostUsd не считался, batch помечался неполным, и предохранитель
  // «дороже $0.05 за контакт» не срабатывал никогда.
  'deepinfra/deepseek-v4-flash-0731':   { in: 0.094, out: 0.38, cached: 0.047 },
  'deepseek-ai/DeepSeek-V4-Flash-0731': { in: 0.094, out: 0.38, cached: 0.047 },
  // На случай downgrade через env
  'claude-haiku-4-5':               { in: 1.0, out: 5.0 },
  'anthropic/claude-haiku-4-5':     { in: 1.0, out: 5.0 },
};

function getApiKey(): string {
  const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_HYPOTHESIS_ENGINE_API_KEY не задан (и нет fallback OPENROUTER_BRIEF_API_KEY)');
  }
  return key;
}

const nonnegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function providerUsage(response: RequestyResponse, requestedModel: string) {
  const usage = response.usage;
  const promptTokens = nonnegative(usage?.prompt_tokens);
  const completionTokens = nonnegative(usage?.completion_tokens);
  const cachedTokens = nonnegative(usage?.prompt_tokens_details?.cached_tokens);
  const reportedCostUsd = nonnegative(usage?.cost);
  // A routed actual model must not be priced as the requested model.
  const actualModel = typeof response.model === 'string' ? response.model : undefined;
  const rateModel = (actualModel ?? requestedModel).replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const prices = MODEL_PRICES[rateModel];
  const estimatedCostUsd = reportedCostUsd === undefined && prices && promptTokens !== undefined && completionTokens !== undefined
    ? ((promptTokens - Math.min(cachedTokens ?? 0, promptTokens)) * prices.in
      + Math.min(cachedTokens ?? 0, promptTokens) * (prices.cached ?? prices.in)
      + completionTokens * prices.out) / 1_000_000 * 1.05
    : undefined;
  return { promptTokens, completionTokens, cachedTokens, reportedCostUsd, estimatedCostUsd,
    ...(actualModel ? { actualModel } : {}),
    ...(typeof response.id === 'string' ? { providerRequestId: response.id } : {}) };
}

/* ─────────────────────── Роли моделей ─────────────────────── */

export type VeModelKind = 'research' | 'chain' | 'bulk' | 'collection' | 'gate' | 'relevanceReview';

export const VE_COLLECTION_MODEL = 'deepinfra/deepseek-v4-flash-0731';

const VE_MODEL_DEFAULTS: Record<VeModelKind, string> = {
  research: 'anthropic/claude-opus-5',
  chain: 'anthropic/claude-opus-5',
  bulk: 'anthropic/claude-sonnet-4-6',
  // Source planning/repair and base composition analysis have their own budget;
  // they must not inherit the research-oriented VE_MODEL_BULK override.
  collection: VE_COLLECTION_MODEL,
  // Дешёвые классификационные задачи (relevance-gate, сегмент-классификатор,
  // case-bank). Допуск компаний отдельно подтверждает relevanceReview.
  gate: VE_COLLECTION_MODEL,
  // Focused entailment check; does not change hypothesis generation models.
  relevanceReview: VE_COLLECTION_MODEL,
};

const VE_MODEL_ENV: Record<VeModelKind, string> = {
  research: 'VE_MODEL_RESEARCH',
  chain: 'VE_MODEL_CHAIN',
  bulk: 'VE_MODEL_BULK',
  collection: 'VE_MODEL_COLLECTION',
  gate: 'VE_MODEL_GATE',
  relevanceReview: 'VE_MODEL_RELEVANCE_REVIEW',
};

/** Модель для роли движка; переопределяется соответствующей переменной VE_MODEL_*. */
export function getVeModel(kind: VeModelKind): string {
  return (process.env[VE_MODEL_ENV[kind]] ?? '').trim() || VE_MODEL_DEFAULTS[kind];
}

/** This rollout keeps the evidence/admission contract. Reuse paid checkpoints
 * from the previous defaults; arbitrary model overrides remain isolated. */
export function veCollectionCacheModel(kind: 'gate' | 'relevanceReview', model: string): string {
  return model === VE_COLLECTION_MODEL
    ? kind === 'gate' ? 'openai/gpt-4o-mini' : 'openai/gpt-5-mini'
    : model;
}

/** Native output constraints verified in the Requesty collection-model pilot.
 * Other configured providers retain JSON mode plus the same local validation. */
export function veNativeJsonSchema(model: string, name: string, schema: z.ZodType) {
  if (model !== VE_COLLECTION_MODEL && !/^(?:openai\/)?(?:gpt-4o-mini|gpt-5-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return undefined;
  return { name, schema: z.toJSONSchema(schema, { io: 'input', override: ({ jsonSchema }) => {
    if (jsonSchema.type === 'object') jsonSchema.additionalProperties = false;
  } }) };
}

/* ─────────────────────── Базовые типы/вызов ─────────────────────── */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMUsage {
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  /** Known reported/estimated amounts only; the provider ledger tracks missing amounts. */
  costUsd: number;
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

interface LLMValidationDetails {
  kind: 'json_syntax' | 'schema' | 'truncated';
  finishReason?: string;
  attempts: number;
}

export class LLMValidationError extends Error {
  constructor(message: string, public readonly rawText: string, public readonly zodError?: unknown,
    public readonly usage?: LLMUsage, public readonly validation?: LLMValidationDetails) {
    super(message);
    this.name = 'LLMValidationError';
  }
}

export interface LLMValidationDiagnostic {
  kind: LLMValidationDetails['kind'] | 'unknown';
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call' | 'other';
  attempts?: number;
  responseChars?: number;
  issueCount?: number;
  issues?: Array<{ code: string; path: Array<string | number> }>;
}

/** Safe for job logs: allow only caller-supplied static schema keys, never issue messages or response values. */
export function getLLMValidationDiagnostic(
  error: unknown,
  safePathKeys: readonly string[] = [],
): LLMValidationDiagnostic | undefined {
  const validation = error instanceof LLMValidationError ? error : undefined;
  const zodError = validation?.zodError instanceof z.ZodError ? validation.zodError
    : error instanceof z.ZodError ? error : undefined;
  if (!validation && !zodError) return undefined;
  const reason = validation?.validation?.finishReason;
  const knownReasons = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'] as const;
  const finishReason = knownReasons.find((value) => value === reason) ?? (reason === undefined ? undefined : 'other');
  const allowedKeys = new Set(safePathKeys);
  const allowedCodes = new Set<string>(Object.values(z.ZodIssueCode));
  return {
    kind: validation?.validation?.kind ?? (zodError ? 'schema' : 'unknown'),
    ...(validation ? { responseChars: validation.rawText.length } : {}),
    ...(validation?.validation ? { attempts: validation.validation.attempts } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(zodError ? {
      issueCount: zodError.issues.length,
      issues: zodError.issues.slice(0, 8).map((issue) => ({
        code: allowedCodes.has(issue.code) ? issue.code : 'custom',
        path: issue.path.slice(0, 12).map((part) =>
          typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 ? part
            : typeof part === 'string' && allowedKeys.has(part) ? part : '*'),
      })),
    } : {}),
  };
}

/** Per-job context: cancelling one project must not abort a parallel project. */
const jobSignals = new AsyncLocalStorage<AbortSignal>();
/** Compatibility for single-flight callers/tests; workers use the scoped API. */
let activeJobSignal: AbortSignal | null = null;

export function withVeActiveJobSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return jobSignals.run(signal, work);
}

export function setVeActiveJobSignal(signal: AbortSignal | null): void {
  activeJobSignal = signal;
}

/** Capture once per operation so late work cannot inherit the next job's signal. */
export function getVeActiveJobSignal(): AbortSignal | null {
  return jobSignals.getStore() ?? activeJobSignal;
}

interface LLMCallOptions {
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Opt in only for models/providers verified to support strict structured outputs. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Classification must not treat a repaired/truncated exclusion list as complete. */
  requireCompleteJson?: boolean;
  /** Narrow callers can reserve exactly one provider request; defaults stay unchanged. */
  maxSchemaAttempts?: 1 | 2;
  maxHttpAttempts?: 1 | 2 | 3 | 4;
  timeoutMs?: number;
  /** Each returned provider usage, including responses later rejected by validation. */
  onUsage?: (usage: LLMUsage) => void;
  /**
   * Provider-specific response contract passed through verbatim, for models
   * that are not plain chat: the System One classifier (Jev) requires
   * `{ type: 'questions', questions }` and answers with calibrated
   * probabilities. Such a call gets no JSON-mode hint appended to its state.
   */
  responseFormat?: Record<string, unknown>;
}

function llmTimeoutMs(): number {
  const configured = Number(process.env.VE_LLM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 30_000 && configured <= 600_000
    ? configured
    : 300_000;
}

function withLLMDeadline<T>(opts: LLMCallOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withVeDeadline('LLM request', opts.timeoutMs ?? llmTimeoutMs(), opts.signal ?? getVeActiveJobSignal(), work);
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

/**
 * Короткие повторы: 408 (таймаут апстрима), 425, 5xx.
 * Для 429 очередь сохраняет длительную паузу, освобождая воркер.
 * Остальные 4xx (ключ, схема, баланс) — постоянные.
 */
const RAW_RETRYABLE_STATUSES = new Set<number>([408, 425, 500, 502, 503, 504]);
/** Сколько повторных попыток после первого вызова (итого 4). */
const RAW_MAX_RETRIES = 3;
/** База экспоненциального бэкоффа: 2с → 4с → 8с. */
const RAW_RETRY_BASE_MS = 2000;

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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function rawCall(
  messages: LLMMessage[],
  model: string,
  maxTokens: number,
  jsonMode: boolean,
  signal: AbortSignal,
  opts?: Pick<LLMCallOptions, 'maxHttpAttempts' | 'onUsage' | 'jsonSchema' | 'responseFormat'>,
): Promise<{ text: string; response: RequestyResponse }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < (opts?.maxHttpAttempts ?? RAW_MAX_RETRIES + 1); attempt++) {
    signal.throwIfAborted();
    if (attempt > 0) await sleep(RAW_RETRY_BASE_MS * 2 ** (attempt - 1), signal);
    signal.throwIfAborted();

    const apiKey = getApiKey();
    const rateGeneration = veLlmRateLimit.beforeRequest(model);
    const metering = await beginProviderUsage('requesty', { requestedModel: model });
    const scope = getProviderUsageScope();
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: jsonMode && !opts?.responseFormat ? withJsonModeHint(messages) : messages,
          max_tokens: maxTokens,
          ...(opts?.responseFormat ? { response_format: opts.responseFormat }
            : jsonMode ? { response_format: opts?.jsonSchema
              ? { type: 'json_schema', json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema } }
              : { type: 'json_object' } } : {}),
          ...(scope ? { requesty: { metadata: {
            feature: 'vertical_engine_v2', project_id: scope.projectId,
            job_id: scope.jobId, stage: scope.stage, ...(scope.baseId ? { base_id: scope.baseId } : {}),
          } } } : {}),
        }),
        signal,
      });
    } catch (err) {
      await metering.finish({ status: 'ambiguous' });
      signal.throwIfAborted();
      if (isAbortError(err)) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (res.ok) {
      let response: RequestyResponse;
      try {
        const parsed: unknown = await res.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Requesty: invalid response envelope');
        response = parsed as RequestyResponse;
      }
      catch (error) {
        await metering.finish({ status: 'ambiguous', httpStatus: res.status });
        throw error;
      }
      // Account received usage before cancellation/JSON validation can discard it.
      const usage = usageOf(response, model);
      opts?.onUsage?.(usage);
      await metering.finish({ status: 'success', httpStatus: res.status, ...providerUsage(response, model) });
      signal.throwIfAborted();
      const text = response.choices?.[0]?.message?.content ?? '';
      return { text, response };
    }

    const status = res.status;
    let body: string;
    try { body = await res.text(); }
    catch (error) { await metering.finish({ status: 'ambiguous', httpStatus: status }); throw error; }
    let failureResponse: RequestyResponse = {};
    try { failureResponse = JSON.parse(body) ?? {}; } catch { /* unknown billing */ }
    const err = new Error(`Requesty ${status}: ${body.slice(0, 300)}`);
    const billing = isVeProviderBillingError(err);
    const rateLimit = status === 429 && !billing
      ? veLlmRateLimit.limited(model, rateGeneration, res.headers?.get('retry-after')) : undefined;
    await metering.finish({ status: 'http_error', httpStatus: status, ...providerUsage(failureResponse, model),
      ...(rateLimit ? { retryAfterMs: Math.max(0, rateLimit.retryAt - Date.now()) } : {}) });
    signal.throwIfAborted();
    // A short in-call retry storm exhausts every base's budget. The worker
    // persists this wait and releases its slot, preserving paid checkpoints.
    if (rateLimit) throw rateLimit;
    if (billing) throw err;
    if (status < 500 && !RAW_RETRYABLE_STATUSES.has(status)) throw err;
    lastError = err;
  }

  throw lastError ?? new Error('Requesty: неизвестная ошибка после ретраев');
}

function usageOf(response: RequestyResponse, model: string): LLMUsage {
  const usage = providerUsage(response, model);
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  return { promptTokens, completionTokens,
    tokensUsed: nonnegative(response.usage?.total_tokens) ?? promptTokens + completionTokens,
    costUsd: usage.reportedCostUsd ?? usage.estimatedCostUsd ?? 0 };
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
 * При невалидном JSON — 1 retry с фидбэком об ошибке. Если и второй
 * раз невалидно — бросает LLMValidationError (воркер помечает job failed).
 */
export async function callLLMWithSchema<T>(
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts: LLMCallOptions,
): Promise<LLMResult<T>> {
  return withLLMDeadline(opts, (signal) => callLLMWithSchemaWithinDeadline(messages, schema, opts, signal));
}

async function callLLMWithSchemaWithinDeadline<T>(
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts: LLMCallOptions,
  signal: AbortSignal,
): Promise<LLMResult<T>> {
  const maxTokens = opts.maxTokens ?? 4096;

  const attempts: Array<{
    text: string;
    error: string;
    kind: LLMValidationDetails['kind'];
    finishReason?: string;
    zodError?: z.ZodError;
  }> = [];
  const total: LLMUsage = { tokensUsed: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };

  for (let attempt = 0; attempt < (opts.maxSchemaAttempts ?? 2); attempt++) {
    signal.throwIfAborted();
    const currentMessages: LLMMessage[] = [...messages];
    if (attempt > 0 && attempts[0]) {
      // A prefix of a valid JSON array looks like a truncated answer and can
      // teach the retry to return only that prefix. Replay intact or omit it.
      const replayPrevious = attempts[0].text.length <= 32_000;
      if (replayPrevious) currentMessages.push({ role: 'assistant', content: attempts[0].text });
      currentMessages.push(
        { role: 'user', content:
          `Твой предыдущий ответ не прошёл валидацию JSON-схемы. Ошибка:\n` +
          `${attempts[0].error}\n\n` +
          (replayPrevious ? '' : 'Предыдущий ответ слишком длинный и здесь полностью опущен.\n') +
          `Сгенерируй заново ПОЛНЫЙ результат по исходному запросу, включая ВСЕ исходные строки, если они были заданы. ` +
          `Не возвращай только исправленные элементы или фрагмент предыдущего ответа. ` +
          `Верни валидный JSON строго по схеме. Никаких markdown-фенсов, никакого текста до/после.`,
        },
      );
    }

    const { text, response } = await rawCall(currentMessages, opts.model, maxTokens, true, signal, opts);
    signal.throwIfAborted();
    const { promptTokens, completionTokens, tokensUsed, costUsd } = usageOf(response, opts.model);
    total.promptTokens += promptTokens;
    total.completionTokens += completionTokens;
    total.tokensUsed += tokensUsed;
    total.costUsd += costUsd;

    const finishReason = response.choices?.[0]?.finish_reason;
    if (opts.requireCompleteJson && finishReason === 'length') {
      attempts.push({ text, finishReason, kind: 'truncated', error: 'Response was truncated; return the complete JSON result.' });
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
      parsed = opts.requireCompleteJson ? null : tryRepairTruncatedJson(cleaned);
      if (parsed === null) {
        attempts.push({ text, finishReason, kind: 'json_syntax', error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      attempts.push({
        text,
        finishReason,
        kind: 'schema',
        zodError: validated.error,
        error: JSON.stringify(validated.error.format()).slice(0, 800),
      });
      continue;
    }

    return {
      data: validated.data,
      ...total,
      rawResponse: response,
    };
  }

  const last = attempts[attempts.length - 1]!;
  throw new LLMValidationError(
    `LLM вернул невалидный JSON (${attempts.length} попыток): ${last.error}`,
    last.text, last.zodError, total,
    { kind: last.kind, finishReason: last.finishReason, attempts: attempts.length },
  );
}

/**
 * Свободный текст без json_object — для генерации цепочек писем и финальных
 * шаблонов (парсинг маркерами ---LETTER N--- через letterParser).
 * Без retry: валидность текста проверяет вызывающая стадия.
 */
export async function callLLMText(
  messages: LLMMessage[],
  opts: LLMCallOptions,
): Promise<LLMTextResult> {
  return withLLMDeadline(opts, (signal) => callLLMTextWithinDeadline(messages, opts, signal));
}

async function callLLMTextWithinDeadline(
  messages: LLMMessage[],
  opts: LLMCallOptions,
  signal: AbortSignal,
): Promise<LLMTextResult> {
  const maxTokens = opts.maxTokens ?? 8192;
  const { text, response } = await rawCall(messages, opts.model, maxTokens, false, signal, opts);
  signal.throwIfAborted();
  const { promptTokens, completionTokens, tokensUsed, costUsd } = usageOf(response, opts.model);
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
 * Включается только явно: opts.fallbackModel или env VE_MODEL_CHAIN_FALLBACK.
 * Условие повтора: основная вернула пустой/короткий текст (< minChars)
 * или finish_reason='content_filter'.
 */
export async function callLLMTextWithFallback(
  messages: LLMMessage[],
  opts: LLMCallOptions & { fallbackModel?: string; minChars?: number; log?: (msg: string) => void },
): Promise<LLMTextResult> {
  return withLLMDeadline(opts, (signal) => callLLMTextWithFallbackWithinDeadline(messages, opts, signal));
}

async function callLLMTextWithFallbackWithinDeadline(
  messages: LLMMessage[],
  opts: LLMCallOptions & { fallbackModel?: string; minChars?: number; log?: (msg: string) => void },
  signal: AbortSignal,
): Promise<LLMTextResult> {
  const minChars = opts.minChars ?? 20;
  const fallbackModel = (opts.fallbackModel ?? process.env.VE_MODEL_CHAIN_FALLBACK ?? '').trim();
  const first = await callLLMTextWithinDeadline(messages, opts, signal);
  signal.throwIfAborted();
  const refused = first.finishReason === 'content_filter' || first.text.length < minChars;
  if (!refused || !fallbackModel || fallbackModel === opts.model) return first;
  opts.log?.(`[llm] ${opts.model}: отказ или пустой ответ (finish=${first.finishReason ?? 'n/a'}, len=${first.text.length}) — повтор на ${fallbackModel}`);
  const second = await callLLMTextWithinDeadline(messages, { ...opts, model: fallbackModel }, signal);
  signal.throwIfAborted();
  // Суммируем стоимость обоих вызовов, текст — от успешного.
  return {
    ...second,
    tokensUsed: first.tokensUsed + second.tokensUsed,
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    costUsd: first.costUsd + second.costUsd,
  };
}
