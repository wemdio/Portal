/**
 * Оркестратор press enricher'а.
 *
 * Особенность: использует кандидатов из ДВУХ kind'ов discovery — 'press' и
 * 'awards', потому что в реальности эти разделы часто пересекаются и
 * объединять их в один AI-запрос — это меньше токенов и лучше связность.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';
import { extractWebsiteText } from '../../extractWebsiteText';
import { fetchSubpages, type FetchedSubpage } from '../../fetchSubpages';
import type { SubpageCandidate } from '../../discoverSubpages';
import type { ClientBriefFields } from '../../../types';
import { buildPressPrompt } from './prompt';
import {
  parsePressResponse,
  pressPatchToBriefPatch,
  type PressEnricherPatch,
} from './parsePressResponse';

const PER_PAGE_TEXT_MAX_CHARS = 10_000;
const MAX_TOKENS_OUTPUT = 2_500;

export interface RunPressEnricherOptions {
  apiKey: string;
  model: string;
  homepageUrl: string;
  candidates: readonly SubpageCandidate[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  callChat?: typeof callOpenRouterChat;
}

export interface RunPressEnricherResult {
  patch: Partial<ClientBriefFields>;
  enricherPatch: PressEnricherPatch;
  pagesFetched: number;
  pagesFailed: number;
  skipReason?: 'no_candidates' | 'no_pages_fetched';
}

const EMPTY_RESULT: RunPressEnricherResult = {
  patch: {},
  enricherPatch: {},
  pagesFetched: 0,
  pagesFailed: 0,
};

export async function runPressEnricher(
  options: RunPressEnricherOptions,
): Promise<RunPressEnricherResult> {
  const {
    apiKey,
    model,
    homepageUrl,
    candidates,
    fetchImpl,
    signal,
    callChat = callOpenRouterChat,
  } = options;

  const relevantCandidates = candidates.filter(
    (c) => c.kind === 'press' || c.kind === 'awards',
  );
  if (relevantCandidates.length === 0) {
    return { ...EMPTY_RESULT, skipReason: 'no_candidates' };
  }

  const fetched = await fetchSubpages({
    urls: relevantCandidates.map((c) => c.url),
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

  const { system, user } = buildPressPrompt({ homepageUrl, pagesText });

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
      title: 'Portal - Press Enricher',
    });
  } catch {
    return {
      patch: {},
      enricherPatch: {},
      pagesFetched: successPages.length,
      pagesFailed: failedCount,
    };
  }

  const enricherPatch = parsePressResponse(aiContent);
  const briefPatch = pressPatchToBriefPatch(enricherPatch);

  return {
    patch: briefPatch,
    enricherPatch,
    pagesFetched: successPages.length,
    pagesFailed: failedCount,
  };
}
