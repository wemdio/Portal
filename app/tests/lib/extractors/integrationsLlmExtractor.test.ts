/**
 * @jest-environment node
 *
 * LLM по /integrations → список сервисов. fetch мокается на global.fetch.
 */

import { llmExtractIntegrations } from '@/lib/enrich/extractors/integrationsLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function intResponse(integrations: unknown) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ integrations }) } }] });
}

const HTML = `<html><body><div class="info">${'Мы дружим со множеством полезных сервисов для удобной работы. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-int';
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

describe('llmExtractIntegrations — early returns', () => {
  it('returns [] without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return intResponse(['amoCRM']); });
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] when text is too short (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return intResponse(['amoCRM']); });
    expect(await llmExtractIntegrations('<body>тонко</body>')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractIntegrations — successful path', () => {
  it('returns the list', async () => {
    withMockFetch(async () => intResponse(['amoCRM', 'Slack', 'Telegram']));
    expect(await llmExtractIntegrations(HTML)).toEqual(['amoCRM', 'Slack', 'Telegram']);
  });

  it('filters junk (length 2..40), dedups case-insensitively', async () => {
    withMockFetch(async () => intResponse(['a', 'amoCRM', 'amocrm', '   ', 'x'.repeat(50), 'Slack']));
    expect(await llmExtractIntegrations(HTML)).toEqual(['amoCRM', 'Slack']);
  });

  it('returns [] when integrations field is missing/not array', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ other: 'x' }) } }] }));
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
});

describe('llmExtractIntegrations — error tolerance', () => {
  it('returns [] on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
  it('returns [] on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
  it('returns [] when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
});
