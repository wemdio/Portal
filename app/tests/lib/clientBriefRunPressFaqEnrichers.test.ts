import { runPressEnricher } from '@/lib/clientBrief/autofill/enrichers/press';
import { runFaqEnricher } from '@/lib/clientBrief/autofill/enrichers/faq';
import type { SubpageCandidate } from '@/lib/clientBrief/autofill/discoverSubpages';

function makeFetchMock(
  pages: Record<string, { status?: number; body?: string }>,
): jest.Mock {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cfg = pages[url];
    if (!cfg) {
      return { ok: false, status: 404, text: async () => 'nf' } as unknown as Response;
    }
    const status = cfg.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => cfg.body ?? '',
    } as unknown as Response;
  });
}

const HOMEPAGE = 'https://acme.ru/';
const PRESS_URL = 'https://acme.ru/press';
const AWARDS_URL = 'https://acme.ru/awards';
const FAQ_URL = 'https://acme.ru/faq';

describe('runPressEnricher', () => {
  const candidates: SubpageCandidate[] = [
    { kind: 'press', url: PRESS_URL, score: 10, source: 'nav' },
    { kind: 'awards', url: AWARDS_URL, score: 10, source: 'nav' },
  ];

  it('skip если нет press/awards кандидатов', async () => {
    const result = await runPressEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [
        { kind: 'cases', url: 'https://acme.ru/cases', score: 10, source: 'nav' },
      ],
      fetchImpl: jest.fn(),
      callChat: jest.fn(),
    });
    expect(result.skipReason).toBe('no_candidates');
  });

  it('грузит обе страницы (press + awards) и заполняет patch', async () => {
    const fetchMock = makeFetchMock({
      [PRESS_URL]: { body: '<html><body>press page</body></html>' },
      [AWARDS_URL]: { body: '<html><body>awards page</body></html>' },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({
        press_comment: 'VC.ru (2024): обзор',
        awards_comment: 'Tagline 2024 — №1',
        media_comment: 'YouTube (2024): эпизод',
      }),
    );
    const result = await runPressEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates,
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(result.pagesFetched).toBe(2);
    expect(result.enricherPatch.press_comment).toContain('VC.ru');
    expect(result.enricherPatch.awards_comment).toContain('Tagline');
    expect(result.enricherPatch.media_comment).toContain('YouTube');
  });

  it('AI-fail не валит', async () => {
    const fetchMock = makeFetchMock({ [PRESS_URL]: { body: 'x' } });
    const callChat = jest.fn(async () => {
      throw new Error('AI fail');
    });
    const result = await runPressEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [{ kind: 'press', url: PRESS_URL, score: 10, source: 'nav' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(result.patch).toEqual({});
  });
});

describe('runFaqEnricher', () => {
  const candidates: SubpageCandidate[] = [
    { kind: 'faq', url: FAQ_URL, score: 10, source: 'nav' },
  ];

  it('skip если нет faq кандидатов', async () => {
    const result = await runFaqEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates: [],
      fetchImpl: jest.fn(),
      callChat: jest.fn(),
    });
    expect(result.skipReason).toBe('no_candidates');
  });

  it('заполняет common_questions и client_problems', async () => {
    const fetchMock = makeFetchMock({
      [FAQ_URL]: { body: '<html><body>faq</body></html>' },
    });
    const callChat = jest.fn(async () =>
      JSON.stringify({
        common_questions: 'В: A?\nО: B\n\nВ: C?\nО: D',
        client_problems: 'Проблема первая длиннее сорока символов\nВторая',
      }),
    );
    const result = await runFaqEnricher({
      apiKey: 'k',
      model: 'm',
      homepageUrl: HOMEPAGE,
      candidates,
      fetchImpl: fetchMock as unknown as typeof fetch,
      callChat: callChat as unknown as typeof import('@/lib/openrouter/client').callOpenRouterChat,
    });
    expect(result.patch.common_questions).toContain('В:');
    expect(result.patch.client_problems).toContain('Вторая');
  });
});
