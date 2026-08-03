/**
 * Orchestrator: fetch site → extract text → call AI → map to safe patch.
 *
 * Used by the POST /api/client/brief/autofill route. Pure of Supabase: it
 * doesn't touch the database. The caller decides what to do with the patch.
 *
 * **Multi-step pipeline (since 2026-05-20):**
 *   1. Fetch homepage HTML.
 *   2. В параллель: (a) main AI-запрос на 19 полей по тексту главной,
 *      (b) discoverSubpages → fetch /sitemap.xml → enricher'ы для targeted
 *      полей (cases / impressive_results / existing_clients).
 *   3. Merge: enricher выигрывает в своих полях, потому что у него
 *      больше контекста (страница кейсов целиком, а не «есть раздел»).
 *   4. Enricher-фейлы не валят основной flow — клиент получит обычный
 *      autofill как раньше.
 */

import { callOpenRouterChatRaw } from '@/lib/openrouter/client';
import { fetchWebsiteHtml, WebsiteFetchError } from './fetchWebsiteHtml';
import { extractWebsiteText } from './extractWebsiteText';
import { mapAutofillToBriefPatch, type AutofillMappedResult } from './mapAutofillToBriefPatch';
import { buildAutofillPrompt } from './prompt';
import { discoverSubpages, type SubpageCandidate } from './discoverSubpages';
import { runCasesEnricher, type RunCasesEnricherResult } from './enrichers/cases';
import { runReviewsEnricher, type RunReviewsEnricherResult } from './enrichers/reviews';
import { runPressEnricher, type RunPressEnricherResult } from './enrichers/press';
import { runFaqEnricher, type RunFaqEnricherResult } from './enrichers/faq';
import type { ClientBriefFields, ClientBriefSocialProofKey } from '../types';

/** Минимальный shared shape для enricher'ов — для trace/merge. */
interface EnricherSummary {
  pagesFetched: number;
  pagesFailed: number;
  filledFields: string[];
  skipReason?: 'no_candidates' | 'no_pages_fetched';
}

export const DEFAULT_AUTOFILL_MODEL =
  process.env.CLIENT_BRIEF_AUTOFILL_MODEL ?? 'policy/gemini-flash';

/**
 * Бросается, когда AI вернул незавершённый ответ (упёрся в max_tokens на
 * стороне модели, finish_reason="length").
 *
 * С 2026-05-20 детектится напрямую через callOpenRouterChatRaw (читает
 * finish_reason). Раньше эвристика "starts with { but does not end" ловила
 * только JSON-output случаи и пропускала text-output, плюс ловила
 * false-positives на «недоwriter-ные» строки. Теперь явная проверка.
 *
 * Без этой ошибки `mapAutofillToBriefPatch.tryParseJson` молча отдаст null →
 * пустой patch → клиент видит «AI ничего не нашёл» (выглядит как баг, а
 * не как «надо повторить»).
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

export interface EnrichersTrace {
  /** Какие URL мы решили запросить как подстраницы. */
  discovered: SubpageCandidate[];
  /** Сводка по cases enricher'у. undefined если не запускался. */
  cases?: EnricherSummary;
  /** Сводка по reviews enricher'у. */
  reviews?: EnricherSummary;
  /** Сводка по press+awards+media enricher'у. */
  press?: EnricherSummary;
  /** Сводка по FAQ enricher'у. */
  faq?: EnricherSummary;
}

export interface GenerateBriefAutofillResult extends AutofillMappedResult {
  resolvedUrl: string;
  /** Диагностика по enricher'ам — для audit-логов, не для UI. */
  enrichers?: EnrichersTrace;
}

export { WebsiteFetchError };

/**
 * Пытается достать sitemap.xml с того же origin. Возвращает undefined если
 * не получилось — это **не ошибка**, sitemap опционален.
 */
async function tryFetchSitemap(
  homepageUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const u = new URL(homepageUrl);
    u.pathname = '/sitemap.xml';
    u.search = '';
    u.hash = '';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4_000);
    try {
      const mergedSignal = signal
        ? mergeAbortSignals(signal, controller.signal)
        : controller.signal;
      const res = await fetchImpl(u.toString(), { signal: mergedSignal });
      if (!res.ok) return undefined;
      const text = await res.text();
      return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return undefined;
  }
}

function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  const c = new AbortController();
  if (a.aborted) c.abort(a.reason);
  else a.addEventListener('abort', () => c.abort(a.reason), { once: true });
  if (b.aborted) c.abort(b.reason);
  else b.addEventListener('abort', () => c.abort(b.reason), { once: true });
  return c.signal;
}

/**
 * Сливает результаты enricher'ов поверх main-patch.
 *
 * Стратегия: enricher выигрывает в своих полях, потому что у него больше
 * контекста (целая страница кейсов/отзывов vs упоминание на главной).
 * main-patch выигрывает во всём остальном. Если enricher не нашёл поле — main
 * не затирается.
 *
 * Между enricher'ами конфликтов в текстовых полях быть не должно — каждый
 * заполняет своё. Для social_proof объединение происходит по ключам: cases
 * пишет .cases, reviews пишет .ratings + .recommendations и т.д.
 */
function mergeEnricherPatches(
  main: Partial<ClientBriefFields>,
  enricherPatches: ReadonlyArray<Partial<ClientBriefFields>>,
): Partial<ClientBriefFields> {
  const merged: Partial<ClientBriefFields> = { ...main };

  const mainSp = main.social_proof as
    | Partial<Record<ClientBriefSocialProofKey, { has: boolean; comment: string }>>
    | undefined;
  let mergedSp: Partial<Record<ClientBriefSocialProofKey, { has: boolean; comment: string }>>
    | undefined = mainSp ? { ...mainSp } : undefined;

  for (const patch of enricherPatches) {
    // Текстовые поля — enricher выигрывает если у него непусто.
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'social_proof') continue;
      if (typeof value === 'string' && value.length > 0) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    if (patch.social_proof) {
      const from = patch.social_proof as Partial<
        Record<ClientBriefSocialProofKey, { has: boolean; comment: string }>
      >;
      mergedSp = { ...(mergedSp ?? {}), ...from };
    }
  }

  if (mergedSp) {
    merged.social_proof = mergedSp as ClientBriefFields['social_proof'];
  }

  return merged;
}

/** Превращает результат любого enricher'а в EnricherSummary для trace'а. */
function summarizeEnricher(result: {
  pagesFetched: number;
  pagesFailed: number;
  skipReason?: EnricherSummary['skipReason'];
  enricherPatch: object;
}): EnricherSummary {
  const patch = result.enricherPatch as Record<string, unknown>;
  return {
    pagesFetched: result.pagesFetched,
    pagesFailed: result.pagesFailed,
    filledFields: Object.keys(patch).filter((k) => patch[k]),
    skipReason: result.skipReason,
  };
}

export async function generateBriefAutofill(
  options: GenerateBriefAutofillOptions,
): Promise<GenerateBriefAutofillResult> {
  const { apiKey, website, fetchImpl, model = DEFAULT_AUTOFILL_MODEL, signal } = options;

  if (!apiKey) throw new Error('CLIENT_BRIEF_AUTOFILL: missing API key');

  const effectiveFetch = fetchImpl ?? fetch;

  const { url, html } = await fetchWebsiteHtml(website, { fetchImpl: effectiveFetch });
  const extracted = extractWebsiteText(html);
  const { system, user } = buildAutofillPrompt({
    website: url,
    websiteText: extracted.combined,
  });

  // Запускаем sitemap fetch и main AI-запрос параллельно. discoverSubpages
  // работает с homepage HTML (он уже есть), но может улучшить ранжирование
  // если sitemap.xml тоже доступен — поэтому ждём sitemap до запуска enricher'ов.
  const sitemapPromise = tryFetchSitemap(url, effectiveFetch, signal);

  const mainAiPromise = callOpenRouterChatRaw({
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
    //
    // 2026-07-27: 6000 → 16000. За policy/gemini-flash стоит reasoning-модель
    // (deepseek-v4-flash): скрытые reasoning_tokens расходуют ТОТ ЖЕ
    // completion-бюджет. На тяжёлых сайтах (длинные прайсы/реестры услуг)
    // reasoning съедал 6000 целиком → finish_reason=length при пустом или
    // обрезанном content (инцидент kelinlaw.ru: 6000/6000 ушло в reasoning,
    // видимый ответ 0 симв.). Замер на том же сайте: reasoning ~5–6.5K +
    // output ~2–3K → 16000 покрывает с запасом. Платим за фактические токены,
    // так что на лёгких сайтах стоимость не растёт.
    maxTokens: 16_000,
    responseFormat: { type: 'json_object' },
    signal,
    title: 'Portal - Client Brief Autofill',
  });

  // Discovery sync (parsing) можно начать сразу — sitemap опционален.
  // Но если sitemap успел догрузиться к моменту запуска enricher'а — учтём.
  const sitemapXml = await sitemapPromise;
  const discovered = discoverSubpages({
    baseUrl: url,
    homepageHtml: html,
    sitemapXml,
  });

  // Enricher'ы запускаются ТОЛЬКО если discovery нашло релевантные страницы.
  // Иначе — пустой результат, никаких лишних AI-вызовов.
  const casesCandidates = discovered.filter((c) => c.kind === 'cases');
  const casesPromise: Promise<RunCasesEnricherResult> = casesCandidates.length
    ? runCasesEnricher({
        apiKey,
        model,
        homepageUrl: url,
        candidates: casesCandidates,
        fetchImpl: effectiveFetch,
        signal,
      })
    : Promise.resolve({
        patch: {},
        enricherPatch: {},
        pagesFetched: 0,
        pagesFailed: 0,
        skipReason: 'no_candidates' as const,
      });

  const reviewsCandidates = discovered.filter((c) => c.kind === 'reviews');
  const reviewsPromise: Promise<RunReviewsEnricherResult> = reviewsCandidates.length
    ? runReviewsEnricher({
        apiKey,
        model,
        homepageUrl: url,
        candidates: reviewsCandidates,
        fetchImpl: effectiveFetch,
        signal,
      })
    : Promise.resolve({
        patch: {},
        enricherPatch: {},
        pagesFetched: 0,
        pagesFailed: 0,
        skipReason: 'no_candidates' as const,
      });

  const pressCandidates = discovered.filter(
    (c) => c.kind === 'press' || c.kind === 'awards',
  );
  const pressPromise: Promise<RunPressEnricherResult> = pressCandidates.length
    ? runPressEnricher({
        apiKey,
        model,
        homepageUrl: url,
        candidates: pressCandidates,
        fetchImpl: effectiveFetch,
        signal,
      })
    : Promise.resolve({
        patch: {},
        enricherPatch: {},
        pagesFetched: 0,
        pagesFailed: 0,
        skipReason: 'no_candidates' as const,
      });

  const faqCandidates = discovered.filter((c) => c.kind === 'faq');
  const faqPromise: Promise<RunFaqEnricherResult> = faqCandidates.length
    ? runFaqEnricher({
        apiKey,
        model,
        homepageUrl: url,
        candidates: faqCandidates,
        fetchImpl: effectiveFetch,
        signal,
      })
    : Promise.resolve({
        patch: {},
        enricherPatch: {},
        pagesFetched: 0,
        pagesFailed: 0,
        skipReason: 'no_candidates' as const,
      });

  const [mainAiResult, casesResult, reviewsResult, pressResult, faqResult] = await Promise.all([
    mainAiPromise,
    casesPromise,
    reviewsPromise,
    pressPromise,
    faqPromise,
  ]);

  const { content: aiContent, finishReason } = mainAiResult;

  // Прямая проверка finish_reason: 'length' = упёрлись в max_tokens, ответ
  // обрезан. Откатываемся на эвристику "starts with { but does not end" только
  // если провайдер не вернул finish_reason (некоторые роутеры так делают).
  if (finishReason === 'length') {
    const tail = aiContent.trim().slice(-40).replace(/\s+/g, ' ');
    throw new AutofillTruncatedError(
      `AI вернул обрезанный ответ (finish_reason=length, ${aiContent.length} симв., хвост: "…${tail}"). ` +
        'Ответ упёрся в лимит токенов. Попробуйте ещё раз — если повторится, сообщите в поддержку.',
    );
  }
  if (finishReason === undefined || finishReason === null) {
    // Fallback: некоторые провайдеры не возвращают finish_reason. Эвристика
    // ловит JSON-output, обрезанный без закрывающей скобки.
    const trimmedContent = aiContent.trim();
    if (trimmedContent.startsWith('{') && !trimmedContent.endsWith('}')) {
      const tail = trimmedContent.slice(-40).replace(/\s+/g, ' ');
      throw new AutofillTruncatedError(
        `AI вернул обрезанный JSON (${trimmedContent.length} симв., хвост: "…${tail}"). ` +
          'Скорее всего, ответ упёрся в лимит токенов. Попробуйте ещё раз — ' +
          'если повторится, сообщите в поддержку.',
      );
    }
  }

  const mapped = mapAutofillToBriefPatch(aiContent);

  // Merge: enricher'ы выигрывают в своих полях.
  const mergedPatch = mergeEnricherPatches(mapped.patch, [
    casesResult.patch,
    reviewsResult.patch,
    pressResult.patch,
    faqResult.patch,
  ]);

  const enrichersTrace: EnrichersTrace = {
    discovered,
    cases: summarizeEnricher(casesResult),
    reviews: summarizeEnricher(reviewsResult),
    press: summarizeEnricher(pressResult),
    faq: summarizeEnricher(faqResult),
  };

  return {
    ...mapped,
    patch: mergedPatch,
    resolvedUrl: url,
    enrichers: enrichersTrace,
  };
}
