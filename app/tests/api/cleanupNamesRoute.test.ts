/**
 * @jest-environment node
 *
 * Контракты POST /api/cleanup-names после перевода на JSON-протокол
 * nameCleanupProtocol (04.07.2026).
 *
 * История бага: роут просил у модели нумерованный текст и в positional
 * fallback'е писал строки БЕЗ снятия «N. » префиксов + без санации
 * спецтокенов — скрин специалиста: «1. Роден», …, «10. Бурятмяс<|eos|>»,
 * дальше блок нетронутых ООО. Масштабный тест 2000 имён: ~20% сбойных
 * батчей даже на здоровой модели. Эти тесты закрепляют:
 *   - JSON-протокол: суб-батчи по 50, response_format json_object;
 *   - маппинг по idx (не по позиции) — перепутанные имена исключены;
 *   - санация префиксов/спецтокенов даже если модель вшила их в JSON;
 *   - text-fallback если модель проигнорировала json_object;
 *   - эвристика + warning при полном отказе AI (retryable);
 *   - 502 при non-retryable ошибке провайдера;
 *   - строки без ответа модели сохраняют оригинал.
 */

import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) =>
    header?.startsWith('Bearer ') ? header.slice(7) : null,
  createAuthedSupabaseClient: () => ({ auth: { getUser: mockGetUser } }),
}));

type RoutePost = (req: NextRequest) => Promise<Response>;
let POST: RoutePost;

const realFetch = global.fetch;
const mockFetch = jest.fn();

beforeAll(async () => {
  process.env.OPENROUTER_CLEANUP_API_KEY = 'test-key';
  process.env.CLEANUP_RETRY_BASE_DELAY_MS = '0';
  ({ POST } = await import('@/app/api/cleanup-names/route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

function makeRequest(companies: unknown): NextRequest {
  return {
    headers: new Headers({ authorization: 'Bearer token-1' }),
    json: async () => ({ companies }),
  } as unknown as NextRequest;
}

function aiResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe('POST /api/cleanup-names (JSON-протокол)', () => {
  it('splits into sub-batches of 50 and sends response_format json_object', async () => {
    // 60 компаний → 2 вызова модели: 50 + 10.
    const companies = Array.from({ length: 60 }, (_, i) => ({
      idx: 100 + i, // idx клиента = rowIndex таблицы, не 0-based
      name: `Компания ${i}`,
    }));

    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body);
      const sentCompanies = JSON.parse(
        sent.messages[1].content,
      ).companies as { idx: number; name: string }[];
      const cleaned = sentCompanies.map((c) => ({ idx: c.idx, name: `Клин${c.idx}` }));
      return aiResponse(JSON.stringify({ cleaned }));
    });

    const res = await POST(makeRequest(companies));
    expect(res.status).toBe(200);
    const { results, warning } = await res.json();

    expect(warning).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(firstBody.messages[1].content).companies).toHaveLength(50);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(JSON.parse(secondBody.messages[1].content).companies).toHaveLength(10);

    expect(results).toHaveLength(60);
    // Маппинг по локальному idx суб-батча → клиентский idx сохранён.
    expect(results[0]).toEqual({ idx: 100, cleanedName: 'Клин0' });
    expect(results[50]).toEqual({ idx: 150, cleanedName: 'Клин0' }); // 2-й суб-батч, локальный idx 0
    expect(results[59]).toEqual({ idx: 159, cleanedName: 'Клин9' });
  });

  it('sanitizes prefixes and special tokens the model baked into JSON names', async () => {
    mockFetch.mockResolvedValue(aiResponse(JSON.stringify({
      cleaned: [
        { idx: 0, name: '1. Роден' },
        { idx: 1, name: 'Бурятмяс<|eos|>' },
      ],
    })));

    const res = await POST(makeRequest([
      { idx: 0, name: 'Роден, плодоовощная продукция' },
      { idx: 1, name: 'Бурятмяс' },
    ]));
    const { results } = await res.json();
    expect(results).toEqual([
      { idx: 0, cleanedName: 'Роден' },
      { idx: 1, cleanedName: 'Бурятмяс' },
    ]);
  });

  it('falls back to text parser when the model ignores json_object (no raw prefixes leak)', async () => {
    mockFetch.mockResolvedValue(aiResponse('1. Планета\n2. Маяк\n3. Триал'));

    const res = await POST(makeRequest([
      { idx: 10, name: 'ООО "ПЛАНЕТА"' },
      { idx: 11, name: 'ООО "МАЯК - ВОСТОК"' },
      { idx: 12, name: 'ООО "ТРИАЛ"' },
    ]));
    const { results } = await res.json();
    expect(results).toEqual([
      { idx: 10, cleanedName: 'Планета' },
      { idx: 11, cleanedName: 'Маяк' },
      { idx: 12, cleanedName: 'Триал' },
    ]);
    for (const r of results) expect(r.cleanedName).not.toMatch(/^\d+[.)]\s/);
  });

  it('keeps original names for rows the model did not answer', async () => {
    mockFetch.mockResolvedValue(aiResponse(JSON.stringify({
      cleaned: [{ idx: 0, name: 'Клин' }], // ответ только на первую из двух
    })));

    const res = await POST(makeRequest([
      { idx: 0, name: 'Грязное 1' },
      { idx: 1, name: 'Грязное 2' },
    ]));
    const { results } = await res.json();
    expect(results).toEqual([
      { idx: 0, cleanedName: 'Клин' },
      { idx: 1, cleanedName: 'Грязное 2' },
    ]);
  });

  it('applies heuristic cleanup with warning when AI is unavailable (retryable)', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const res = await POST(makeRequest([
      { idx: 0, name: 'ООО "ПЛАНЕТА"' },
      { idx: 1, name: 'АО "НАЦРЫБПРОМ"' },
    ]));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Portal-Name-Cleanup-Fallback')).toBe('heuristic');
    const { results, warning } = await res.json();
    expect(typeof warning).toBe('string');
    expect(warning).toContain('локальная очистка');
    // Эвристика снимает ООО/АО и кавычки — не сырые оригиналы.
    expect(results.find((r: { idx: number }) => r.idx === 0).cleanedName).toBe('Планета');
    expect(results.find((r: { idx: number }) => r.idx === 1).cleanedName).toBe('Нацрыбпром');
    // 4 попытки на единственный суб-батч.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('returns 502 immediately on non-retryable provider error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    });

    const res = await POST(makeRequest([{ idx: 0, name: 'Acme' }]));
    expect(res.status).toBe(502);
    expect(mockFetch).toHaveBeenCalledTimes(1); // без ретраев
    const { error } = await res.json();
    expect(error).toContain('Invalid API key');
  });

  it('retries on 5xx then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(aiResponse(JSON.stringify({
        cleaned: [{ idx: 0, name: 'Клин' }],
      })));

    const res = await POST(makeRequest([{ idx: 0, name: 'Грязное' }]));
    expect(res.status).toBe(200);
    const { results, warning } = await res.json();
    expect(warning).toBeUndefined();
    expect(results).toEqual([{ idx: 0, cleanedName: 'Клин' }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unauthenticated requests', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(makeRequest([{ idx: 0, name: 'Acme' }]));
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects empty companies array', async () => {
    const res = await POST(makeRequest([]));
    expect(res.status).toBe(400);
  });
});
