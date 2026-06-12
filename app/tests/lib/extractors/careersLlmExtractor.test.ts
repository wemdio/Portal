/**
 * @jest-environment node
 *
 * LLM по /careers: vacancies (число|«N+») + professions. fetch мокается на global.fetch.
 */

import { llmExtractHiring } from '@/lib/enrich/extractors/careersLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function hiringResponse(vacancies_count: number, approximate: boolean, professions: string[]) {
  return mockJsonResponse({
    choices: [{ message: { content: JSON.stringify({ vacancies_count, approximate, professions }) } }],
  });
}

const CAREERS_HTML = `<html><body><div class="team">${'Мы растём и ищем новых сотрудников в команду. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-careers';
  delete process.env.OPENROUTER_BRIEF_API_KEY;
});
afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.OPENROUTER_SIGNALS_API_KEY;
  else process.env.OPENROUTER_SIGNALS_API_KEY = ORIG_KEY;
  if (ORIG_BRIEF === undefined) delete process.env.OPENROUTER_BRIEF_API_KEY;
  else process.env.OPENROUTER_BRIEF_API_KEY = ORIG_BRIEF;
  jest.clearAllMocks();
});

describe('llmExtractHiring — early returns', () => {
  it('returns null without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return hiringResponse(3, false, ['Повара']); });
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when text is too short (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return hiringResponse(3, false, ['Повара']); });
    expect(await llmExtractHiring('<body>тонко</body>')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractHiring — successful path', () => {
  it('exact count + professions', async () => {
    withMockFetch(async () => hiringResponse(12, false, ['Лифтёры', 'Монтажники']));
    expect(await llmExtractHiring(CAREERS_HTML)).toEqual({ vacancies: 12, professions: ['Лифтёры', 'Монтажники'] });
  });

  it('approximate count → «N+»', async () => {
    withMockFetch(async () => hiringResponse(10, true, []));
    expect(await llmExtractHiring(CAREERS_HTML)).toEqual({ vacancies: '10+', professions: [] });
  });

  it('vacancies 0 but professions present → vacancies null', async () => {
    withMockFetch(async () => hiringResponse(0, false, ['Бариста']));
    expect(await llmExtractHiring(CAREERS_HTML)).toEqual({ vacancies: null, professions: ['Бариста'] });
  });

  it('returns null when both vacancies 0 and professions empty', async () => {
    withMockFetch(async () => hiringResponse(0, false, []));
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });

  it('filters junk professions (length 3..60, max 5)', async () => {
    withMockFetch(async () => hiringResponse(0, false, ['ok', 'Грузчики', '   ', 'Электромонтажники']));
    const r = await llmExtractHiring(CAREERS_HTML);
    expect(r?.professions).toEqual(['Грузчики', 'Электромонтажники']);
  });
});

describe('llmExtractHiring — error tolerance', () => {
  it('returns null on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });
  it('returns null when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });
});
