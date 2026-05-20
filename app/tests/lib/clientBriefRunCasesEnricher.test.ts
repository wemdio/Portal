import { runCasesEnricher } from '@/lib/clientBrief/autofill/enrichers/cases';
import type { SubpageCandidate } from '@/lib/clientBrief/autofill/discoverSubpages';

function makeFetchMock(
  pages: Record<string, { status?: number; body?: string; throwError?: Error }>,
): jest.Mock {
  // Не используем jsdom Response (он флакает с .text()); возвращаем
  // минимальный объект достаточный для fetchWebsiteHtml.
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cfg = pages[url];
    if (!cfg) {
      return {
        ok: false,
        status: 404,
        text: async () => 'not found',
      } as unknown as Response;
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
const CASES_URL = 'https://acme.ru/cases';

const casesCandidate: SubpageCandidate = {
  kind: 'cases',
  url: CASES_URL,
  score: 10,
  source: 'nav',
  anchorText: 'Кейсы',
};

describe('runCasesEnricher', () => {
  it('skip с "no_candidates" если на входе нет cases-кандидатов', async () => {
    const result = await runCasesEnricher({
      apiKey: 'key',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [],
      fetchImpl: jest.fn(),
      callChat: jest.fn(),
    });
    expect(result.skipReason).toBe('no_candidates');
    expect(result.patch).toEqual({});
  });

  it('skip с "no_pages_fetched" если все подстраницы упали', async () => {
    const fetchMock = makeFetchMock({
      [CASES_URL]: { status: 500 },
    });
    const callChat = jest.fn();
    const result = await runCasesEnricher({
      apiKey: 'key',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [casesCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(result.skipReason).toBe('no_pages_fetched');
    expect(result.pagesFailed).toBe(1);
    expect(callChat).not.toHaveBeenCalled();
  });

  it('заполняет patch когда AI вернул валидный JSON', async () => {
    const fetchMock = makeFetchMock({
      [CASES_URL]: {
        body: `<html><body>
          <h1>Наши кейсы</h1>
          <p>Кейс 1: Петрович — внедрили email-outreach — 142 лида за квартал.</p>
          <p>Кейс 2: Selectel — холодные письма — выручка +28 млн ₽.</p>
        </body></html>`,
      },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({
        cases_comment:
          'Петрович — email-outreach — 142 лида\nSelectel — холодные письма — +28 млн ₽',
        impressive_results: 'Средний ROI x3.5',
        existing_clients: 'Петрович, Selectel',
      }),
    );

    const result = await runCasesEnricher({
      apiKey: 'key',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [casesCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.pagesFetched).toBe(1);
    expect(result.enricherPatch.cases_comment).toContain('Петрович');
    expect(result.patch.impressive_results).toBe('Средний ROI x3.5');
    expect(result.patch.existing_clients).toBe('Петрович, Selectel');
    const sp = result.patch.social_proof as { cases?: { has: boolean; comment: string } };
    expect(sp.cases?.has).toBe(true);
  });

  it('не валит общий поток если AI-вызов упал — возвращает пустой patch', async () => {
    const fetchMock = makeFetchMock({
      [CASES_URL]: { body: '<html><body>cases</body></html>' },
    });
    const callChat = jest.fn(async () => {
      throw new Error('AI service unavailable');
    });

    const result = await runCasesEnricher({
      apiKey: 'key',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [casesCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });

    expect(result.patch).toEqual({});
    expect(result.pagesFetched).toBe(1);
  });

  it('фильтрует "отписку" в ответе AI — patch остаётся пустым', async () => {
    const fetchMock = makeFetchMock({
      [CASES_URL]: { body: '<html><body>cases</body></html>' },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({
        cases_comment: 'Есть раздел кейсов на сайте',
        impressive_results: '',
        existing_clients: '',
      }),
    );

    const result = await runCasesEnricher({
      apiKey: 'key',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [casesCandidate],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });

    expect(result.patch).toEqual({});
    expect(result.enricherPatch.cases_comment).toBeUndefined();
  });

  it('пропускает не-cases кандидатов и работает только с cases', async () => {
    const fetchMock = makeFetchMock({
      [CASES_URL]: { body: '<html><body>cases</body></html>' },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({ cases_comment: 'Клиент X — задача — рез' }),
    );

    const result = await runCasesEnricher({
      apiKey: 'key',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [
        casesCandidate,
        { kind: 'reviews', url: 'https://acme.ru/reviews', score: 10, source: 'nav' },
        { kind: 'press', url: 'https://acme.ru/press', score: 10, source: 'nav' },
      ],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });

    // Должен загрузить только cases URL, не reviews/press.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.pagesFetched).toBe(1);
  });
});
