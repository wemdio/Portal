import { runReviewsEnricher } from '@/lib/clientBrief/autofill/enrichers/reviews';
import type { SubpageCandidate } from '@/lib/clientBrief/autofill/discoverSubpages';

function makeFetchMock(
  pages: Record<string, { status?: number; body?: string; throwError?: Error }>,
): jest.Mock {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cfg = pages[url];
    if (!cfg) {
      return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response;
    }
    if (cfg.throwError) throw cfg.throwError;
    const status = cfg.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => cfg.body ?? '',
    } as unknown as Response;
  });
}

const HOMEPAGE = 'https://acme.ru/';
const REVIEWS_URL = 'https://acme.ru/reviews';

const reviewsCandidate: SubpageCandidate = {
  kind: 'reviews',
  url: REVIEWS_URL,
  score: 10,
  source: 'nav',
};

describe('runReviewsEnricher', () => {
  it('skip с "no_candidates" если на входе нет reviews-кандидатов', async () => {
    const result = await runReviewsEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [],
      fetchImpl: jest.fn(),
      callChat: jest.fn(),
    });
    expect(result.skipReason).toBe('no_candidates');
  });

  it('skip с "no_pages_fetched" если все подстраницы упали', async () => {
    const fetchMock = makeFetchMock({ [REVIEWS_URL]: { status: 500 } });
    const result = await runReviewsEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [reviewsCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: jest.fn() as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(result.skipReason).toBe('no_pages_fetched');
  });

  it('заполняет patch когда AI вернул валидный JSON', async () => {
    const fetchMock = makeFetchMock({
      [REVIEWS_URL]: { body: '<html><body>reviews page</body></html>' },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({
        ratings_comment: 'Яндекс.Карты: 4.8/5 (124)',
        recommendations_comment: 'Иван Петров, CMO: «Эффективно»',
      }),
    );

    const result = await runReviewsEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [reviewsCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });

    expect(result.enricherPatch.ratings_comment).toContain('4.8/5');
    expect(result.enricherPatch.recommendations_comment).toContain('Иван');
    const sp = result.patch.social_proof as Record<string, { has: boolean; comment: string }>;
    expect(sp.ratings?.has).toBe(true);
    expect(sp.recommendations?.has).toBe(true);
  });

  it('AI-fail не валит — возвращает пустой patch', async () => {
    const fetchMock = makeFetchMock({
      [REVIEWS_URL]: { body: '<html><body>reviews</body></html>' },
    });
    const callChat = jest.fn(async () => {
      throw new Error('AI down');
    });

    const result = await runReviewsEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [reviewsCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(result.patch).toEqual({});
    expect(result.pagesFetched).toBe(1);
  });

  it('пропускает не-reviews кандидатов', async () => {
    const fetchMock = makeFetchMock({
      [REVIEWS_URL]: { body: '<html><body>reviews</body></html>' },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({ ratings_comment: 'Y: 4.8/5' }),
    );
    await runReviewsEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [
        reviewsCandidate,
        { kind: 'cases', url: 'https://acme.ru/cases', score: 10, source: 'nav' },
      ],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
