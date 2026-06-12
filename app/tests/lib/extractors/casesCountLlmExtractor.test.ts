/**
 * @jest-environment node
 *
 * LLM-счётчик кейсов. fetch мокается на уровне global.fetch.
 */

import { llmCountCases } from '@/lib/enrich/extractors/casesCountLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function countResponse(count: number, approximate: boolean) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ count, approximate }) } }] });
}

// Текст ≥200 символов, чтобы пройти guard.
const CASES_HTML = `<html><body><div class="portfolio">${'Кейс для клиента: внедрили CRM и подняли продажи. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-cases-count';
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

describe('llmCountCases — early returns', () => {
  it('returns null without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return countResponse(5, true); });
    expect(await llmCountCases(CASES_HTML)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when there is too little text (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return countResponse(5, true); });
    expect(await llmCountCases('<body>тонко</body>')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('llmCountCases — successful path', () => {
  it('returns a plain number when approximate=false', async () => {
    withMockFetch(async () => countResponse(23, false));
    expect(await llmCountCases(CASES_HTML)).toBe(23);
  });

  it('returns «N+» string when approximate=true', async () => {
    withMockFetch(async () => countResponse(20, true));
    expect(await llmCountCases(CASES_HTML)).toBe('20+');
  });

  it('returns null when count is 0 (no cases)', async () => {
    withMockFetch(async () => countResponse(0, false));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
});

describe('llmCountCases — error tolerance', () => {
  it('returns null on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
  it('returns null when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
  it('returns null when count is not a number', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ count: 'many' }) } }] }));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
});
