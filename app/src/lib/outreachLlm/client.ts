/**
 * Общий ИИ-клиент автоаутричей RU и EN
 * (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md §1).
 *
 * У каждого аутрича свой ключ Requesty (POLZA_RU_OUTREACH_API_KEY /
 * POLZA_EN_OUTREACH_API_KEY): расход виден в кабинете отдельно, а сбой или
 * лимит одного ключа не задевает другой аутрич и остальные фичи портала.
 * Модель — по роли: дешёвая для разбора (analysis), Gemini 3.1 Pro для
 * цепочек писем (writer); обе переопределяются env.
 *
 * Язык и бюджет приходят из контекста запуска (context.ts). Каждый оплаченный
 * ответ сразу списывается с бюджета — даже если потом не разобрался: деньги
 * уже потрачены, и лимит обязан это видеть.
 *
 * Транспорт — прямой fetch, как в lib/openrouter/client.ts: тот бросает
 * обычный Error и теряет usage, а здесь нужны стоимость каждого ответа и типы
 * ошибок (ключ / сбой / бюджет), от которых зависит судьба запуска.
 */

import {
  BudgetExceededError,
  currentOutreachContext,
  LlmAuthError,
  LlmCallError,
  type JobBudget,
  type OutreachLang,
  type OutreachLlmRole,
} from './context';
import { bareModelName, estimateCostUsd } from './prices';

export type { OutreachLang, OutreachLlmRole } from './context';

const DEFAULT_ENDPOINT = 'https://router.requesty.ai/v1/chat/completions';

// Id — как в каталоге Requesty, с префиксом поставщика: без него Requesty
// может молча ответить другой моделью (см. replyPersonalization/geminiClient.ts).
const DEFAULT_MODELS: Record<OutreachLlmRole, string> = {
  analysis: 'deepinfra/deepseek-v4-flash-0731',
  writer: 'google/gemini-3.1-pro-preview',
};

const API_KEY_ENV: Record<OutreachLang, string> = {
  ru: 'POLZA_RU_OUTREACH_API_KEY',
  en: 'POLZA_EN_OUTREACH_API_KEY',
};

const MODEL_ENV: Record<OutreachLang, Record<OutreachLlmRole, string>> = {
  ru: { analysis: 'POLZA_RU_ANALYSIS_MODEL', writer: 'POLZA_RU_WRITER_MODEL' },
  en: { analysis: 'POLZA_EN_ANALYSIS_MODEL', writer: 'POLZA_EN_WRITER_MODEL' },
};

const LANG_LABEL: Record<OutreachLang, string> = { ru: 'RU', en: 'EN' };

// Разбор извлекает факты — выдумка не нужна; письмам нужна живость.
const TEMPERATURE: Record<OutreachLlmRole, number> = { analysis: 0, writer: 0.4 };
const DEFAULT_MAX_TOKENS: Record<OutreachLlmRole, number> = { analysis: 1500, writer: 8000 };
// Gemini тратит токены на размышление: обрезанный ответ повторяем с удвоенным
// лимитом, но не выше этого.
const MAX_TOKENS_CAP = 16_000;
// Без таймаута зависший запрос держал бы строку, а с ней и запуск, бесконечно.
// Писатель думает долго — ему больше.
const REQUEST_TIMEOUT_MS: Record<OutreachLlmRole, number> = { analysis: 120_000, writer: 300_000 };
// 429/5xx/сеть: ещё две попытки через 2 и 4 с. 408 и 425 — те же таймауты
// апстрима, что и 5xx. Остальные 4xx постоянны: повтор заплатит за ту же ошибку.
const TRANSPORT_RETRIES = 2;
const RETRY_BASE_MS = 2_000;
const RETRYABLE_STATUS = new Set([408, 425, 429]);
// Как у движка вертикалей (collectionErrors.ts): кончились деньги — это не сбой
// одной строки, а причина остановить запуск.
const BILLING_TEXT =
  /not enough credits|insufficient[\s_-]+(?:funds|balance|credits)|payment[\s_-]+required|credit balance (?:is )?too low/i;

// json_object-режим у части поставщиков отвечает 400, если слово «json» не
// встречается в сообщениях (движок вертикалей наступил на это) — добавляем сами.
const JSON_HINT: Record<OutreachLang, string> = {
  ru: 'Верни ответ строго как валидный JSON-объект: без markdown-ограждений и без текста до или после.',
  en: 'Return strictly a valid JSON object: no markdown fences, no text before or after.',
};
// Повтор того же запроса при температуре 0 вернёт тот же битый ответ — просим явно.
const JSON_RETRY_NUDGE: Record<OutreachLang, string> = {
  ru: 'Предыдущий ответ не разобрался как JSON-объект. Верни только валидный JSON-объект, ничего кроме него.',
  en: 'The previous answer could not be parsed as a JSON object. Return only a valid JSON object and nothing else.',
};

export function outreachApiKey(lang: OutreachLang): string {
  return (process.env[API_KEY_ENV[lang]] ?? '').trim();
}

export function outreachModel(lang: OutreachLang, role: OutreachLlmRole): string {
  return (process.env[MODEL_ENV[lang][role]] ?? '').trim() || DEFAULT_MODELS[role];
}

export interface OutreachLlmUsage {
  role: OutreachLlmRole;
  /** Модель, которая ответила по данным Requesty; если он её не назвал — запрошенная. */
  model: string;
  costUsd: number;
  /** reported — usage.cost от Requesty; estimated — наша оценка по prices.ts. */
  costSource: 'reported' | 'estimated';
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface OutreachLlmCallOptions {
  role: OutreachLlmRole;
  system: string;
  user: string;
  /** Короткая метка вызова для заголовка X-Title и логов: «site», «vacancy», «chain-hiring». */
  title: string;
  maxTokens?: number;
  /** Явный язык важнее контекста; вне runWithOutreachContext обязателен, и бюджета тогда нет. */
  lang?: OutreachLang;
  /**
   * Каждый оплаченный ответ, в том числе отвергнутый потом как битый: так
   * шаблон цепочки знает свою стоимость и модель (polza_chain_templates).
   */
  onUsage?: (usage: OutreachLlmUsage) => void;
}

/** Один вызов со строгим JSON-объектом в ответе. */
export async function callOutreachJson(opts: OutreachLlmCallOptions): Promise<Record<string, unknown>> {
  return callOutreach(opts, true, parseJsonObject);
}

/** Свободный текст — для писателя, если JSON неудобен. Обрезанный ответ не принимается. */
export async function callOutreachText(opts: OutreachLlmCallOptions): Promise<string> {
  return callOutreach(opts, false, (content) => content.trim() || null);
}

/* ─────────────────────────── Внутреннее ─────────────────────────── */

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface CallSpec {
  lang: OutreachLang;
  role: OutreachLlmRole;
  title: string;
  apiKey: string;
  model: string;
  json: boolean;
}

interface Answer {
  content: string;
  truncated: boolean;
}

type Outcome = { ok: true; answer: Answer } | { ok: false; error: LlmCallError };

interface RequestyEnvelope {
  model?: unknown;
  choices?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } | null;
  error?: unknown;
  message?: unknown;
}

interface RequestyChoice {
  message?: { content?: unknown } | null;
  finish_reason?: unknown;
}

async function callOutreach<T>(
  opts: OutreachLlmCallOptions,
  json: boolean,
  accept: (content: string) => T | null,
): Promise<T> {
  const ctx = currentOutreachContext();
  const lang = opts.lang ?? ctx?.lang;
  if (!lang) {
    // Ошибка программиста, а не ИИ: пусть падает громко, а не прячется в «ИИ не ответил».
    throw new Error(`Outreach LLM «${opts.title}»: язык не задан — вызов вне runWithOutreachContext без opts.lang`);
  }
  const budget = ctx?.budget ?? null;
  const apiKey = outreachApiKey(lang);
  if (!apiKey) {
    throw new LlmAuthError(`Не задан ключ ИИ для ${LANG_LABEL[lang]} автоаутрича (${API_KEY_ENV[lang]})`, 'missing_key');
  }
  // Ключ с пробелом или кириллицей (битая строка в .env) fetch отверг бы как
  // сетевую ошибку — каждая строка ждала бы повторов и падала бы по одной.
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new LlmAuthError(`Неверный ключ ИИ для ${LANG_LABEL[lang]} автоаутрича: недопустимые символы в ${API_KEY_ENV[lang]}`);
  }
  const call: CallSpec = { lang, role: opts.role, title: opts.title, apiKey, model: outreachModel(lang, opts.role), json };
  const baseMessages = buildMessages(opts, call);

  const charge = (usage: OutreachLlmUsage): void => {
    budget?.add(usage.role, usage.costUsd);
    if (usage.costSource === 'estimated') {
      warnOnce(`cost:${usage.model}`, `${label(call)}: Requesty не вернул usage.cost (${usage.model}) — стоимость оценена по таблице цен`);
    }
    if (bareModelName(usage.model) !== bareModelName(call.model)) {
      warnOnce(`model:${call.model}>${usage.model}`, `${label(call)}: запрошена модель ${call.model}, ответила ${usage.model}`);
    }
    try {
      opts.onUsage?.(usage);
    } catch (err) {
      // Учёт вызывающего не должен ронять вызов, за который уже заплатили.
      log('warn', `${label(call)}: onUsage упал — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let maxTokens = initialMaxTokens(opts);
  let grewForLength = false;
  let retriedBadAnswer = false;
  let nudge = false;
  for (;;) {
    const messages = nudge ? [...baseMessages, { role: 'user' as const, content: JSON_RETRY_NUDGE[lang] }] : baseMessages;
    const answer = await requestWithRetries(call, messages, maxTokens, budget, charge);
    const canGrow = maxTokens < MAX_TOKENS_CAP;
    if (answer.truncated && call.role === 'writer' && canGrow && !grewForLength) {
      grewForLength = true;
      maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
      log('info', `${label(call)}: ответ обрезан по лимиту токенов — повтор с max_tokens=${maxTokens}`);
      continue;
    }
    // Обрезанный текст — недописанное письмо. Обрезанный JSON, если всё же
    // разобрался, целый: скобки сошлись, значит объект закрыт.
    const value = answer.truncated && !call.json ? null : accept(answer.content);
    if (value !== null) return value;

    const problem = answer.truncated
      ? `ответ обрезан на max_tokens=${maxTokens}`
      : call.json
        ? 'ответ не разбирается как JSON-объект'
        : 'пустой ответ';
    // Обрезанный на потолке ответ обрежется и в повторе — не платим за него дважды.
    if (retriedBadAnswer || (answer.truncated && !canGrow)) {
      throw new LlmCallError(`${label(call)}: ${problem}`);
    }
    retriedBadAnswer = true;
    if (answer.truncated) {
      // С тем же лимитом ответ обрежется снова — повтор с запасом.
      maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
    } else {
      nudge = call.json;
    }
    log('warn', `${label(call)}: ${problem} — повтор`);
  }
}

function initialMaxTokens(opts: OutreachLlmCallOptions): number {
  const requested = opts.maxTokens;
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), MAX_TOKENS_CAP)
    : DEFAULT_MAX_TOKENS[opts.role];
}

function buildMessages(opts: OutreachLlmCallOptions, call: CallSpec): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Пустой system часть поставщиков отвергает с 400.
  if (opts.system.trim()) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });
  if (call.json && !/json/i.test(`${opts.system}\n${opts.user}`)) {
    messages.push({ role: 'user', content: JSON_HINT[call.lang] });
  }
  return messages;
}

function ensureBudget(budget: JobBudget | null): void {
  if (!budget || !budget.exhausted()) return;
  throw new BudgetExceededError(
    `Достигнут лимит на ИИ: потрачено $${budget.spentUsd.toFixed(2)} из $${budget.limitUsd.toFixed(2)}`,
  );
}

async function requestWithRetries(
  call: CallSpec,
  messages: ChatMessage[],
  maxTokens: number,
  budget: JobBudget | null,
  charge: (usage: OutreachLlmUsage) => void,
): Promise<Answer> {
  let lastError: LlmCallError | null = null;
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const pauseMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      log('warn', `${lastError?.message ?? label(call)} — повтор ${attempt}/${TRANSPORT_RETRIES} через ${pauseMs / 1000} с`);
      await sleep(pauseMs);
    }
    // Перед каждым запросом, включая повторы: пока этот поток ждал, лимит мог
    // выбрать другой.
    ensureBudget(budget);
    const outcome = await requestOnce(call, messages, maxTokens, charge);
    if (outcome.ok) return outcome.answer;
    lastError = outcome.error;
  }
  throw lastError ?? new LlmCallError(`${label(call)}: нет ответа после повторов`);
}

/** Retryable-сбой возвращается, постоянный (ключ, деньги, прочие 4xx) — бросается. */
async function requestOnce(
  call: CallSpec,
  messages: ChatMessage[],
  maxTokens: number,
  charge: (usage: OutreachLlmUsage) => void,
): Promise<Outcome> {
  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  let res: Response;
  let text: string;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${call.apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': headerSafe(`Portal - Polza ${LANG_LABEL[call.lang]} Outreach ${call.title}`),
      },
      body: JSON.stringify({
        model: call.model,
        messages,
        temperature: TEMPERATURE[call.role],
        max_tokens: maxTokens,
        ...(call.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS[call.role]),
    });
    // Тело читаем под тем же таймаутом: оборванный ответ мог быть оплачен,
    // но usage из него не достать — остаётся только повторить.
    text = await res.text();
  } catch (err) {
    return { ok: false, error: new LlmCallError(`${label(call)}: ${networkProblem(err, call)}`) };
  }

  const envelope = parseEnvelope(text);
  const choice = firstChoice(envelope);
  if (envelope && (envelope.usage || choice)) {
    // Ошибки Requesty обычно бесплатны, но если он что-то посчитал — учитываем.
    charge(usageOf(envelope, choice, call, promptChars));
  }

  if (res.ok) {
    if (choice) {
      return { ok: true, answer: { content: contentOf(choice), truncated: isTruncated(choice.finish_reason) } };
    }
    if (!envelope) {
      return { ok: false, error: new LlmCallError(`${label(call)}: Requesty вернул не JSON`, res.status) };
    }
    // 200 без ответа модели — ошибка поставщика в конверте: код берём из неё.
    return failure(call, errorCodeOf(envelope) ?? 502, providerMessage(envelope, text, call));
  }
  return failure(call, res.status, providerMessage(envelope, text, call));
}

function failure(call: CallSpec, status: number, message: string): Outcome {
  const where = `Requesty ${status}${message ? `: ${message}` : ''}`;
  if (status === 402 || BILLING_TEXT.test(message)) {
    throw new LlmAuthError(`Закончились деньги на ключе ИИ для ${LANG_LABEL[call.lang]} автоаутрича (${where})`, 'billing');
  }
  if (status === 401 || status === 403) {
    throw new LlmAuthError(`Неверный ключ ИИ для ${LANG_LABEL[call.lang]} автоаутрича (${where})`, 'rejected_key');
  }
  const error = new LlmCallError(`${label(call)}: ${where}`, status);
  if (RETRYABLE_STATUS.has(status) || status >= 500) return { ok: false, error };
  throw error;
}

function endpoint(): string {
  return (process.env.OPENROUTER_ENDPOINT ?? '').trim() || DEFAULT_ENDPOINT;
}

function parseEnvelope(text: string): RequestyEnvelope | null {
  const tryParse = (raw: string): RequestyEnvelope | null => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RequestyEnvelope) : null;
    } catch {
      return null;
    }
  };
  // Как в openrouter/client.ts: прокси иногда дописывает мусор вокруг JSON.
  return tryParse(text) ?? tryParse(text.match(/\{[\s\S]*\}/)?.[0] ?? '');
}

function firstChoice(envelope: RequestyEnvelope | null): RequestyChoice | null {
  const choices = envelope?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as unknown;
  return first && typeof first === 'object' ? (first as RequestyChoice) : null;
}

function contentOf(choice: RequestyChoice): string {
  const content = choice.message?.content;
  if (typeof content === 'string') return content;
  // OpenAI-формат частями: [{ type: 'text', text }].
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

function isTruncated(finishReason: unknown): boolean {
  return typeof finishReason === 'string' && /^(?:length|max_tokens)$/i.test(finishReason);
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(
  envelope: RequestyEnvelope,
  choice: RequestyChoice | null,
  call: CallSpec,
  promptChars: number,
): OutreachLlmUsage {
  const usage = envelope.usage ?? undefined;
  const promptTokens = nonNegative(usage?.prompt_tokens);
  const completionTokens = nonNegative(usage?.completion_tokens);
  const model = typeof envelope.model === 'string' && envelope.model.trim() ? envelope.model.trim() : call.model;
  const reported = nonNegative(usage?.cost);
  if (reported !== null) {
    return { role: call.role, model, costUsd: reported, costSource: 'reported', promptTokens, completionTokens };
  }
  // Без usage.cost — оценка по токенам, без токенов — по длине текста (~3
  // символа на токен). Сначала по модели, которая ответила: Requesty мог
  // подменить модель, и цена запрошенной была бы неверной. Модель без цены —
  // по тарифу писателя, самому дорогому: лимиту лучше сработать раньше, чем
  // недосчитать.
  const tokensIn = promptTokens ?? Math.ceil(promptChars / 3);
  const tokensOut = completionTokens ?? Math.ceil((choice ? contentOf(choice).length : 0) / 3);
  const costUsd = estimateCostUsd(model, tokensIn, tokensOut)
    ?? estimateCostUsd(call.model, tokensIn, tokensOut)
    ?? estimateCostUsd(DEFAULT_MODELS.writer, tokensIn, tokensOut)
    ?? 0;
  return { role: call.role, model, costUsd, costSource: 'estimated', promptTokens, completionTokens };
}

function errorCodeOf(envelope: RequestyEnvelope): number | null {
  const error = envelope.error;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const status = typeof code === 'number' ? code : typeof code === 'string' ? Number(code) : NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function providerMessage(envelope: RequestyEnvelope | null, rawText: string, call: CallSpec): string {
  const error = envelope?.error;
  const fromError = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : null;
  const fromEnvelope = typeof envelope?.message === 'string' ? envelope.message : null;
  // Сырой ответ прокси бывает HTML-страницей — теги в тексте ошибки не нужны;
  // пустой JSON-объект ничего не объясняет — хватит кода.
  const fallback = envelope && Object.keys(envelope).length === 0 ? '' : rawText.replace(/<[^>]*>/g, ' ');
  return redact(fromError ?? fromEnvelope ?? fallback, call.apiKey).slice(0, 200);
}

function networkProblem(err: unknown, call: CallSpec): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `нет ответа за ${REQUEST_TIMEOUT_MS[call.role] / 1000} с`;
  }
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  // undici кладёт в текст ошибки значение заголовка — а там ключ.
  return `сеть — ${redact(code ? `${message} (${code})` : message, call.apiKey)}`;
}

/** Текст ошибки уходит в логи и в журнал запуска — ключа в нём быть не должно. */
function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join('***') : text;
  return withoutKey.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/\s+/g, ' ').trim();
}

/** fetch бросает TypeError на не-latin1 в заголовке: кириллица в title уронила бы каждый вызов. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '?').slice(0, 150);
}

function label(call: CallSpec): string {
  return `${LANG_LABEL[call.lang]} ${call.role} «${call.title}»`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: 'info' | 'warn', message: string): void {
  console[level](`[outreach-llm][${level.toUpperCase()}] ${message}`);
}

const warnedOnce = new Set<string>();

/** Одинаковое предупреждение на каждый вызов залило бы лог воркера — раз на процесс. */
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key) || warnedOnce.size >= 200) return;
  warnedOnce.add(key);
  log('warn', message);
}

/** Как в polzaRuOutreach/llm.ts: снимаем markdown-ограждения, берём объект, массив не принимаем. */
function parseJsonObject(content: string): Record<string, unknown> | null {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const slice = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (!slice) return null;
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
