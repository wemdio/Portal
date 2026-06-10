/**
 * @jest-environment node
 *
 * LLM-сигнал «Клиенты» (сегмент ЦА). Проверяем:
 *  1. Без API-ключа → '' (без сетевых вызовов).
 *  2. Пустой mainHtml → ''.
 *  3. Нет материала (короткий текст, нет alt) → '' без вызова LLM.
 *  4. Успех: модель вернула сегмент → нормализованная строка.
 *  5. Нормализация: кавычки/точка/длина срезаются.
 *  6. 429 / кривой JSON / throw / отсутствует поле → ''.
 *
 * fetch мокается на уровне global.fetch — не дёргаем requesty и не зависим от ключа.
 */

import { extractClientSegment } from '@/lib/enrich/extractors/clientSegmentExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}

function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function segmentResponse(segment: string) {
  return mockJsonResponse({
    choices: [{ message: { content: JSON.stringify({ segment }) } }],
  });
}

// Материал, гарантирующий hasMaterial=true: секция с logo-alt + длинный текст.
const HTML_WITH_CLIENTS = `
  <html><body>
    <section class="clients"><img alt="Стоматология Дента" /></section>
    <p>${'Мы делаем сайты и CRM для частных стоматологических клиник. '.repeat(8)}</p>
  </body></html>
`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-for-client-segment';
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

describe('extractClientSegment — early returns', () => {
  it('returns "" when no API key is configured (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...args) => { calls.push(args); return segmentResponse('стоматологии'); });
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('returns "" when mainHtml is empty', async () => {
    expect(await extractClientSegment('')).toBe('');
  });

  it('skips the LLM call when there is no alt AND text is too short', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...args) => { calls.push(args); return segmentResponse('x'); });
    const html = '<html><body><h1>Привет</h1><p>тут пусто</p></body></html>';
    expect(await extractClientSegment(html)).toBe('');
    expect(calls).toHaveLength(0);
  });
});

describe('extractClientSegment — successful path', () => {
  it('returns the model segment', async () => {
    withMockFetch(async () => segmentResponse('стоматологии'));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('стоматологии');
  });

  it('normalizes surrounding quotes, trailing dot and length', async () => {
    withMockFetch(async () => segmentResponse('  "B2B-стройка".  '));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('B2B-стройка');
  });

  it('returns "" when the model says it cannot tell', async () => {
    withMockFetch(async () => segmentResponse(''));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });
});

describe('extractClientSegment — error tolerance', () => {
  it('returns "" on non-2xx (429/5xx)', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });

  it('returns "" on malformed JSON content', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'not json {{' } }] }));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });

  it('returns "" when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });

  it('returns "" when segment field is missing or not a string', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ other: 'x' }) } }] }));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });
});
