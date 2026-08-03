/**
 * Оркестратор FAQ enricher'а. Архитектура зеркалит остальные enricher'ы.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';
import { extractWebsiteText } from '../../extractWebsiteText';
import { fetchSubpages, type FetchedSubpage } from '../../fetchSubpages';
import type { SubpageCandidate } from '../../discoverSubpages';
import type { ClientBriefFields } from '../../../types';
import { buildFaqPrompt } from './prompt';
import {
  parseFaqResponse,
  faqPatchToBriefPatch,
  type FaqEnricherPatch,
} from './parseFaqResponse';

const PER_PAGE_TEXT_MAX_CHARS = 12_000;
// 8000 а не 2500: reasoning-модель за policy/gemini-flash расходует скрытые
// reasoning_tokens из того же completion-бюджета (см. autofill/index.ts).
const MAX_TOKENS_OUTPUT = 8_000;

export interface RunFaqEnricherOptions {
  apiKey: string;
  model: string;
  homepageUrl: string;
  candidates: readonly SubpageCandidate[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  callChat?: typeof callOpenRouterChat;
}

export interface RunFaqEnricherResult {
  patch: Partial<ClientBriefFields>;
  enricherPatch: FaqEnricherPatch;
  pagesFetched: number;
  pagesFailed: number;
  skipReason?: 'no_candidates' | 'no_pages_fetched';
}

const EMPTY_RESULT: RunFaqEnricherResult = {
  patch: {},
  enricherPatch: {},
  pagesFetched: 0,
  pagesFailed: 0,
};

export async function runFaqEnricher(
  options: RunFaqEnricherOptions,
): Promise<RunFaqEnricherResult> {
  const {
    apiKey,
    model,
    homepageUrl,
    candidates,
    fetchImpl,
    signal,
    callChat = callOpenRouterChat,
  } = options;

  const faqCandidates = candidates.filter((c) => c.kind === 'faq');
  if (faqCandidates.length === 0) {
    return { ...EMPTY_RESULT, skipReason: 'no_candidates' };
  }

  const fetched = await fetchSubpages({
    urls: faqCandidates.map((c) => c.url),
    fetchImpl,
  });

  const successPages = fetched.filter((p): p is FetchedSubpage & { html: string } => !!p.html);
  const failedCount = fetched.length - successPages.length;

  if (successPages.length === 0) {
    return { ...EMPTY_RESULT, pagesFailed: failedCount, skipReason: 'no_pages_fetched' };
  }

  const pagesText = successPages
    .map((page) => {
      const extracted = extractWebsiteText(page.html, { maxChars: PER_PAGE_TEXT_MAX_CHARS });
      const url = page.resolvedUrl ?? page.url;
      const body = extracted.combined || '(пусто)';
      return `## ${url}\n${body}`;
    })
    .join('\n\n---\n\n');

  const { system, user } = buildFaqPrompt({ homepageUrl, pagesText });

  let aiContent: string;
  try {
    aiContent = await callChat({
      apiKey,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      maxTokens: MAX_TOKENS_OUTPUT,
      responseFormat: { type: 'json_object' },
      signal,
      title: 'Portal - FAQ Enricher',
    });
  } catch {
    return {
      patch: {},
      enricherPatch: {},
      pagesFetched: successPages.length,
      pagesFailed: failedCount,
    };
  }

  const enricherPatch = parseFaqResponse(aiContent);
  const briefPatch = faqPatchToBriefPatch(enricherPatch);

  return {
    patch: briefPatch,
    enricherPatch,
    pagesFetched: successPages.length,
    pagesFailed: failedCount,
  };
}
