/**
 * Orchestrator: fetch site → extract text → call AI → map to safe patch.
 *
 * Used by the POST /api/client/brief/autofill route. Pure of Supabase: it
 * doesn't touch the database. The caller decides what to do with the patch.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';
import { fetchWebsiteHtml, WebsiteFetchError } from './fetchWebsiteHtml';
import { extractWebsiteText } from './extractWebsiteText';
import { mapAutofillToBriefPatch, type AutofillMappedResult } from './mapAutofillToBriefPatch';
import { buildAutofillPrompt } from './prompt';

export const DEFAULT_AUTOFILL_MODEL =
  process.env.CLIENT_BRIEF_AUTOFILL_MODEL ?? 'policy/gemini-flash';

/**
 * Бросается, когда AI вернул незавершённый JSON (обычно — упёрся в max_tokens
 * на стороне модели, finish_reason="length"). `callOpenRouterChat` возвращает
 * только `content` и проглатывает `finish_reason`, поэтому truncation для
 * нас невидим напрямую. Детектим эвристикой: ответ начался с "{" но не
 * закрылся "}". Без этой проверки `mapAutofillToBriefPatch.tryParseJson`
 * молча отдаст null → пустой patch → клиент видит «AI ничего не нашёл»
 * (выглядит как баг, а не как «надо повторить»).
 */
export class AutofillTruncatedError extends Error {
  readonly code = 'AUTOFILL_TRUNCATED';
  constructor(message: string) {
    super(message);
    this.name = 'AutofillTruncatedError';
  }
}

export interface GenerateBriefAutofillOptions {
  apiKey: string;
  website: string;
  /** Optional injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional model override (env-driven by default). */
  model?: string;
  /** Optional AbortSignal forwarded to the AI call. */
  signal?: AbortSignal;
}

export interface GenerateBriefAutofillResult extends AutofillMappedResult {
  resolvedUrl: string;
}

export { WebsiteFetchError };

export async function generateBriefAutofill(
  options: GenerateBriefAutofillOptions,
): Promise<GenerateBriefAutofillResult> {
  const { apiKey, website, fetchImpl, model = DEFAULT_AUTOFILL_MODEL, signal } = options;

  if (!apiKey) throw new Error('CLIENT_BRIEF_AUTOFILL: missing API key');

  const { url, html } = await fetchWebsiteHtml(website, { fetchImpl });
  const extracted = extractWebsiteText(html);
  const { system, user } = buildAutofillPrompt({
    website: url,
    websiteText: extracted.combined,
  });

  const aiContent = await callOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    // Расширенный whitelist (19 полей вместо 11) + source-snippets для каждого
    // заполненного поля → ответ может занимать 4-5K токенов. Старый лимит 3500
    // приводил к усечённому JSON и failed parse.
    maxTokens: 6000,
    responseFormat: { type: 'json_object' },
    signal,
    title: 'Portal - Client Brief Autofill',
  });

  // Эвристика truncation: если ответ начался как JSON-объект, но не
  // закрылся — модель почти наверняка упёрлась в max_tokens на своей стороне
  // (8K у Gemini Flash, 6K у нас) и вернула finish_reason="length", который
  // openrouter-клиент проглатывает. Лучше упасть с осмысленной ошибкой,
  // чем тихо отдать пустой patch.
  const trimmedContent = aiContent.trim();
  if (trimmedContent.startsWith('{') && !trimmedContent.endsWith('}')) {
    const tail = trimmedContent.slice(-40).replace(/\s+/g, ' ');
    throw new AutofillTruncatedError(
      `AI вернул обрезанный JSON (${trimmedContent.length} симв., хвост: "…${tail}"). ` +
        'Скорее всего, ответ упёрся в лимит токенов. Попробуйте ещё раз — ' +
        'если повторится, сообщите в поддержку.',
    );
  }

  const mapped = mapAutofillToBriefPatch(aiContent);
  return { ...mapped, resolvedUrl: url };
}
