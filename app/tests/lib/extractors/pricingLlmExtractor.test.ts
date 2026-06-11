/**
 * @jest-environment node
 *
 * LLM по /pricing: model + min + free_trial. fetch мокается на global.fetch.
 */

import { llmExtractPricing } from '@/lib/enrich/extractors/pricingLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function pricingResponse(obj: unknown) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

const PRICING_HTML = `<html><body><div class="plans">${'Тариф для бизнеса с расширенными возможностями и поддержкой. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-pricing';
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

describe('llmExtractPricing — early returns', () => {
  it('returns null without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return pricingResponse({ pricing_model: 'self-serve' }); });
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when text is too short (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return pricingResponse({ pricing_model: 'self-serve' }); });
    expect(await llmExtractPricing('<body>тонко</body>')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractPricing — successful path', () => {
  it('full result', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: 'self-serve', pricing_min: { value: 990, currency: 'RUB' }, free_trial: true }));
    expect(await llmExtractPricing(PRICING_HTML)).toEqual({
      pricing_model: 'self-serve',
      pricing_min: { value: 990, currency: 'RUB' },
      free_trial: true,
    });
  });

  it('partial: only free_trial=false', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: null, pricing_min: null, free_trial: false }));
    expect(await llmExtractPricing(PRICING_HTML)).toEqual({
      pricing_model: null, pricing_min: null, free_trial: false,
    });
  });

  it('filters invalid model and bad price → all null → returns null', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: 'foo', pricing_min: { value: 0, currency: 'RUB' }, free_trial: null }));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });

  it('rejects price without valid currency', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: null, pricing_min: { value: 500, currency: 'XYZ' }, free_trial: null }));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
});

describe('llmExtractPricing — error tolerance', () => {
  it('returns null on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
  it('returns null when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
});
