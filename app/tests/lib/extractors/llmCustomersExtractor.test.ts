/**
 * @jest-environment node
 *
 * Specialized LLM fallback для «Клиенты»: интеграционно проверяем что:
 *
 *  1. Без API-ключа возвращается [] (без сетевых вызовов).
 *  2. Successful path: модель вернула список, junk-фильтр пропустил
 *     реальные бренды и выкинул прокрашенные «card img», «visa», «DSC 1 scaled».
 *  3. Невалидный JSON / ошибка 429 / timeout → возвращается [] (не throw'ит).
 *  4. Если на странице вообще нет hint'ов и текст короткий — модель не
 *     вызывается (экономия токенов).
 *
 * Сетевой fetch мокается на уровне global.fetch, чтобы не дёргать
 * router.requesty.ai и не зависеть от живого ключа в CI.
 */

import { llmExtractCustomers } from '@/lib/enrich/extractors/llmCustomersExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}

function mockJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-for-llm-customers';
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

describe('llmExtractCustomers — early returns', () => {
  it('returns [] when no API key is configured (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...args) => { calls.push(args); return mockJsonResponse({}); });

    const html = '<section class="clients"><img alt="Газпром"/></section>';
    const result = await llmExtractCustomers(html);
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] when html is empty', async () => {
    const result = await llmExtractCustomers('');
    expect(result).toEqual([]);
  });

  it('skips the LLM call when there is no client-like hint AND text is too short', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...args) => { calls.push(args); return mockJsonResponse({}); });
    // Очень короткая страница без classов «client*»/«partner*»/«brand*».
    const html = '<html><body><h1>Привет</h1><p>тут пусто</p></body></html>';
    const result = await llmExtractCustomers(html);
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractCustomers — successful path', () => {
  it('returns the model output filtered through the junk filter', async () => {
    withMockFetch(async () => mockJsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            customers: [
              'Газпром', 'Сбербанк', 'МТС', 'Volkswagen',
              // Junk that should be dropped by filterCustomerCandidates:
              'card img', 'visa', 'arrow', 'DSC 1 scaled',
              'gallery grid 1 x',
            ],
          }),
        },
      }],
    }));

    const html = `
      <section class="clients">
        <img alt="card img"/>
        <img alt="Газпром"/>
      </section>
    `;
    const result = await llmExtractCustomers(html);
    expect(result).toEqual(expect.arrayContaining(['Газпром', 'Сбербанк', 'МТС', 'Volkswagen']));
    expect(result).not.toContain('card img');
    expect(result).not.toContain('visa');
    expect(result).not.toContain('arrow');
    expect(result).not.toContain('DSC 1 scaled');
    expect(result).not.toContain('gallery grid 1 x');
  });

  it('deduplicates names returned multiple times by the model', async () => {
    withMockFetch(async () => mockJsonResponse({
      choices: [{ message: { content: JSON.stringify({ customers: ['Газпром', 'газпром', 'ГАЗПРОМ'] }) } }],
    }));

    const html = '<section class="brands"><img alt="x"/></section>';
    const result = await llmExtractCustomers(html);
    expect(result).toHaveLength(1);
    expect(result[0].toLowerCase()).toBe('газпром');
  });

  it('caps the final list at 50 entries even when the model returns more', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `Бренд${i + 1}`);
    withMockFetch(async () => mockJsonResponse({
      choices: [{ message: { content: JSON.stringify({ customers: many }) } }],
    }));

    const html = '<section class="clients"><img alt="x"/></section>';
    const result = await llmExtractCustomers(html);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe('llmExtractCustomers — error tolerance', () => {
  it('returns [] on non-2xx response (rate limit / 5xx)', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    const html = '<section class="clients"><img alt="x"/></section>';
    expect(await llmExtractCustomers(html)).toEqual([]);
  });

  it('returns [] on malformed JSON in the model response', async () => {
    withMockFetch(async () => mockJsonResponse({
      choices: [{ message: { content: 'not a json {{' } }],
    }));
    const html = '<section class="clients"><img alt="x"/></section>';
    expect(await llmExtractCustomers(html)).toEqual([]);
  });

  it('returns [] when the network call throws (timeout, dns fail)', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    const html = '<section class="clients"><img alt="x"/></section>';
    expect(await llmExtractCustomers(html)).toEqual([]);
  });

  it('returns [] when customers field is missing or not an array', async () => {
    withMockFetch(async () => mockJsonResponse({
      choices: [{ message: { content: JSON.stringify({ other: ['x', 'y'] }) } }],
    }));
    const html = '<section class="clients"><img alt="x"/></section>';
    expect(await llmExtractCustomers(html)).toEqual([]);
  });
});
