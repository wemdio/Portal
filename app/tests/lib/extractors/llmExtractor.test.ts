/**
 * @jest-environment node
 *
 * Консолидированный LLM-экстрактор сайтовых сигналов (один запрос на все поля,
 * что не закрыли эвристики). fetch мокается на global.fetch. Проверяем разбор
 * объединённого JSON, gating по needed-набору и нормализацию «N+» / сегмента.
 */

jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(), logError: jest.fn() }));

import { llmExtractFields, LlmFields } from '@/lib/enrich/extractors/llmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function llmResponse(obj: unknown) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

const MAIN_HTML = `<html><body><h1>Компания</h1><p>${'Делаем продукт для бизнеса и помогаем расти. '.repeat(4)}</p></body></html>`;
const ALL: Array<keyof LlmFields> = [
  'pricing_model', 'pricing_min', 'free_trial', 'customers', 'client_segment',
  'founded_year', 'team_size', 'case_industries', 'cases_count',
  'vacancies_count', 'hiring_roles', 'integrations',
];

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-llm';
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

describe('llmExtractFields — early returns (no network)', () => {
  it('returns {} without API key', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return llmResponse({}); });
    expect(await llmExtractFields(MAIN_HTML, {}, new Set(['pricing_model']))).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('returns {} when needed set is empty', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return llmResponse({}); });
    expect(await llmExtractFields(MAIN_HTML, {}, new Set())).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('returns {} when combined text is too short', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return llmResponse({ team_size: 5 }); });
    expect(await llmExtractFields('<body>x</body>', {}, new Set(['team_size']))).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractFields — parsing & normalization', () => {
  it('maps the full consolidated JSON, with «N+» estimates', async () => {
    withMockFetch(async () => llmResponse({
      pricing_model: 'sales-led',
      pricing_min: { value: 50000, currency: 'rub' },
      free_trial: false,
      client_segment: 'стоматологии',
      founded_year: 2018,
      team_size: 40,
      case_industries: ['Медицина и фарма'],
      cases_count: { count: 23, approximate: true },
      vacancies_count: { count: 7, approximate: false },
      hiring_roles: ['Лифтёры', 'Монтажники'],
      integrations: ['amoCRM', 'Slack'],
    }));

    const res = await llmExtractFields(MAIN_HTML, {}, new Set(ALL));

    expect(res.pricing_model).toBe('sales-led');
    expect(res.pricing_min).toEqual({ value: 50000, currency: 'RUB' }); // currency upper-cased
    expect(res.free_trial).toBe(false); // false must be kept (renders «Нет»)
    expect(res.client_segment).toBe('стоматологии');
    expect(res.founded_year).toBe(2018);
    expect(res.team_size).toBe(40);
    expect(res.case_industries).toEqual(['Медицина и фарма']);
    expect(res.cases_count).toBe('23+');        // approximate → "N+"
    expect(res.vacancies_count).toBe(7);         // exact → number
    expect(res.hiring_roles).toEqual(['Лифтёры', 'Монтажники']);
    expect(res.integrations).toEqual(['amoCRM', 'Slack']);
  });

  it('only returns fields present in the needed set (gating)', async () => {
    withMockFetch(async () => llmResponse({
      pricing_model: 'self-serve',
      cases_count: { count: 10, approximate: false },
      client_segment: 'интернет-магазины',
      team_size: 99,
    }));

    const res = await llmExtractFields(MAIN_HTML, {}, new Set(['pricing_model']));
    expect(res).toEqual({ pricing_model: 'self-serve' });
  });

  it('vacancies_count approximate → "N+"', async () => {
    withMockFetch(async () => llmResponse({ vacancies_count: { count: 7, approximate: true } }));
    const res = await llmExtractFields(MAIN_HTML, {}, new Set(['vacancies_count']));
    expect(res.vacancies_count).toBe('7+');
  });

  it('strips quotes/trailing dot from client_segment', async () => {
    withMockFetch(async () => llmResponse({ client_segment: '«B2B-стройка».' }));
    const res = await llmExtractFields(MAIN_HTML, {}, new Set(['client_segment']));
    expect(res.client_segment).toBe('B2B-стройка');
  });

  it('drops invalid pricing_min (value 0) and out-of-range counts', async () => {
    withMockFetch(async () => llmResponse({
      pricing_min: { value: 0, currency: 'RUB' },
      cases_count: { count: 0, approximate: false },
    }));
    const res = await llmExtractFields(MAIN_HTML, {}, new Set(['pricing_min', 'cases_count']));
    expect(res.pricing_min).toBeUndefined();
    expect(res.cases_count).toBeUndefined();
  });
});

describe('llmExtractFields — error tolerance', () => {
  it('returns {} on HTTP error', async () => {
    withMockFetch(async () => mockJsonResponse({}, 500));
    expect(await llmExtractFields(MAIN_HTML, {}, new Set(['team_size']))).toEqual({});
  });

  it('returns {} on malformed JSON content', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'not json {{{' } }] }));
    expect(await llmExtractFields(MAIN_HTML, {}, new Set(['team_size']))).toEqual({});
  });

  it('returns {} when fetch throws', async () => {
    withMockFetch(async () => { throw new Error('network'); });
    expect(await llmExtractFields(MAIN_HTML, {}, new Set(['team_size']))).toEqual({});
  });
});
