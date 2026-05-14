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

  const mapped = mapAutofillToBriefPatch(aiContent);
  return { ...mapped, resolvedUrl: url };
}
