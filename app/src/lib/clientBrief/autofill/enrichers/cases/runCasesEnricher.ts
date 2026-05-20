/**
 * Оркестратор cases enricher'а.
 *
 * Берёт URL-кандидатов от discoverSubpages(kind='cases'), грузит их через
 * fetchSubpages, извлекает текст, склеивает в один prompt context, дёргает
 * модель, парсит, возвращает Partial<ClientBriefFields>.
 *
 * Дизайн-решения:
 * - **Лимит per-page = 12K символов** (вместо 40K для главной). У нас 1-3
 *   страницы кейсов, каждая может быть длинной — лучше взять 12K с каждой
 *   чем 40K с одной и пропустить другие. С DeepSeek V4 Flash (128K окно)
 *   3 страницы × 12K симв ≈ 9K токенов на input — безопасно.
 * - **Тих фейл**: если ни одна страница не загрузилась — возвращаем пустой
 *   patch, не бросаем. Это enricher, а не критический путь.
 * - **maxTokens output = 2500** — узкий формат (3 поля, лаконичные строки),
 *   2500 хватит за глаза. Если ещё раз обрежется — поднимем.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';
import { extractWebsiteText } from '../../extractWebsiteText';
import { fetchSubpages, type FetchedSubpage } from '../../fetchSubpages';
import type { SubpageCandidate } from '../../discoverSubpages';
import type { ClientBriefFields } from '../../../types';
import { buildCasesPrompt } from './prompt';
import { casesPatchToBriefPatch, parseCasesResponse, type CasesEnricherPatch } from './parseCasesResponse';

const PER_PAGE_TEXT_MAX_CHARS = 12_000;
const MAX_TOKENS_OUTPUT = 2_500;

export interface RunCasesEnricherOptions {
  apiKey: string;
  model: string;
  homepageUrl: string;
  candidates: readonly SubpageCandidate[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Override callOpenRouterChat для тестов. */
  callChat?: typeof callOpenRouterChat;
}

export interface RunCasesEnricherResult {
  /** Patch для слияния в общий результат автозаполнения. Пустой объект — нет данных. */
  patch: Partial<ClientBriefFields>;
  /** Что нашли — для логов/трейсов. */
  enricherPatch: CasesEnricherPatch;
  /** Сколько подстраниц реально загрузилось (для логов). */
  pagesFetched: number;
  /** Сколько подстраниц упало (для логов). */
  pagesFailed: number;
  /** Скип-причина если enricher не запускался. */
  skipReason?: 'no_candidates' | 'no_pages_fetched';
}

const EMPTY_RESULT: RunCasesEnricherResult = {
  patch: {},
  enricherPatch: {},
  pagesFetched: 0,
  pagesFailed: 0,
};

export async function runCasesEnricher(
  options: RunCasesEnricherOptions,
): Promise<RunCasesEnricherResult> {
  const {
    apiKey,
    model,
    homepageUrl,
    candidates,
    fetchImpl,
    signal,
    callChat = callOpenRouterChat,
  } = options;

  // Filter to cases-only (caller может передать общий список — мы защищаемся).
  const casesCandidates = candidates.filter((c) => c.kind === 'cases');
  if (casesCandidates.length === 0) {
    return { ...EMPTY_RESULT, skipReason: 'no_candidates' };
  }

  const fetched = await fetchSubpages({
    urls: casesCandidates.map((c) => c.url),
    fetchImpl,
  });

  const successPages = fetched.filter((p): p is FetchedSubpage & { html: string } => !!p.html);
  const failedCount = fetched.length - successPages.length;

  if (successPages.length === 0) {
    return { ...EMPTY_RESULT, pagesFailed: failedCount, skipReason: 'no_pages_fetched' };
  }

  // Склеиваем в одно "тело" с заголовками "## URL\n" чтобы модель видела
  // границы между страницами и могла различать кейсы из разных разделов.
  const pagesText = successPages
    .map((page) => {
      const extracted = extractWebsiteText(page.html, { maxChars: PER_PAGE_TEXT_MAX_CHARS });
      const url = page.resolvedUrl ?? page.url;
      const body = extracted.combined || '(пусто)';
      return `## ${url}\n${body}`;
    })
    .join('\n\n---\n\n');

  const { system, user } = buildCasesPrompt({ homepageUrl, pagesText });

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
      title: 'Portal - Cases Enricher',
    });
  } catch {
    // Enricher failure не должен валить общий autofill. Возвращаем пусто,
    // главный поток заполнит cases как может.
    return {
      patch: {},
      enricherPatch: {},
      pagesFetched: successPages.length,
      pagesFailed: failedCount,
    };
  }

  const enricherPatch = parseCasesResponse(aiContent);
  const briefPatch = casesPatchToBriefPatch(enricherPatch);

  return {
    patch: briefPatch,
    enricherPatch,
    pagesFetched: successPages.length,
    pagesFailed: failedCount,
  };
}
