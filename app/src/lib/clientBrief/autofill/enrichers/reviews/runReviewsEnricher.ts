/**
 * Оркестратор reviews enricher'а. Архитектура зеркалит runCasesEnricher.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';
import { extractWebsiteText } from '../../extractWebsiteText';
import { fetchSubpages, type FetchedSubpage } from '../../fetchSubpages';
import type { SubpageCandidate } from '../../discoverSubpages';
import type { ClientBriefFields } from '../../../types';
import { buildReviewsPrompt } from './prompt';
import {
  parseReviewsResponse,
  reviewsPatchToBriefPatch,
  type ReviewsEnricherPatch,
} from './parseReviewsResponse';

const PER_PAGE_TEXT_MAX_CHARS = 12_000;
const MAX_TOKENS_OUTPUT = 2_000;

export interface RunReviewsEnricherOptions {
  apiKey: string;
  model: string;
  homepageUrl: string;
  candidates: readonly SubpageCandidate[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  callChat?: typeof callOpenRouterChat;
}

export interface RunReviewsEnricherResult {
  patch: Partial<ClientBriefFields>;
  enricherPatch: ReviewsEnricherPatch;
  pagesFetched: number;
  pagesFailed: number;
  skipReason?: 'no_candidates' | 'no_pages_fetched';
}

const EMPTY_RESULT: RunReviewsEnricherResult = {
  patch: {},
  enricherPatch: {},
  pagesFetched: 0,
  pagesFailed: 0,
};

export async function runReviewsEnricher(
  options: RunReviewsEnricherOptions,
): Promise<RunReviewsEnricherResult> {
  const {
    apiKey,
    model,
    homepageUrl,
    candidates,
    fetchImpl,
    signal,
    callChat = callOpenRouterChat,
  } = options;

  const reviewsCandidates = candidates.filter((c) => c.kind === 'reviews');
  if (reviewsCandidates.length === 0) {
    return { ...EMPTY_RESULT, skipReason: 'no_candidates' };
  }

  const fetched = await fetchSubpages({
    urls: reviewsCandidates.map((c) => c.url),
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

  const { system, user } = buildReviewsPrompt({ homepageUrl, pagesText });

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
      title: 'Portal - Reviews Enricher',
    });
  } catch {
    return {
      patch: {},
      enricherPatch: {},
      pagesFetched: successPages.length,
      pagesFailed: failedCount,
    };
  }

  const enricherPatch = parseReviewsResponse(aiContent);
  const briefPatch = reviewsPatchToBriefPatch(enricherPatch);

  return {
    patch: briefPatch,
    enricherPatch,
    pagesFetched: successPages.length,
    pagesFailed: failedCount,
  };
}
