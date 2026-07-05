/**
 * Тесты LLM-отсева B2C (classifyCompanies.ts): батчинг, парсинг вердиктов,
 * fail-open на все виды сбоев. Сам LLM замокан через global.fetch.
 */

import { llmClassifyNoise, type CompanyForClassify } from '@/lib/outreachos/classifyCompanies';

const originalFetch = global.fetch;
const originalKey = process.env.OPENROUTER_CLEANUP_API_KEY;

function llmResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function companies(n: number): CompanyForClassify[] {
  return Array.from({ length: n }, (_, i) => ({ name: `Компания ${i}`, website: `https://c${i}.ru` }));
}

afterEach(() => {
  global.fetch = originalFetch;
  process.env.OPENROUTER_CLEANUP_API_KEY = originalKey;
  delete process.env.OUTREACHOS_CLASSIFY_API_KEY;
  jest.restoreAllMocks();
});

beforeEach(() => {
  process.env.OPENROUTER_CLEANUP_API_KEY = 'test-key';
});

describe('llmClassifyNoise', () => {
  it('без API-ключа — fail-open: пустой noise, 0 вердиктов', async () => {
    process.env.OPENROUTER_CLEANUP_API_KEY = '';
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(3));
    expect(res.noise.size).toBe(0);
    expect(res.classified).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пустой вход — без вызовов', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await llmClassifyNoise([]);
    expect(res.noise.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('выкидывает только B2C/IP/GOV; B2B/MIXED/UNCLEAR остаются', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      llmResponse(
        JSON.stringify({
          verdicts: [
            { i: 1, c: 'B2B' },
            { i: 2, c: 'B2C' },
            { i: 3, c: 'MIXED' },
            { i: 4, c: 'IP' },
            { i: 5, c: 'GOV' },
            { i: 6, c: 'UNCLEAR' },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(6));
    expect([...res.noise].sort()).toEqual([1, 3, 4]); // 0-based: B2C, IP, GOV
    expect(res.classified).toBe(6);
    expect(res.failedBatches).toBe(0);
  });

  it('батчит по 40 и смещает индексы между батчами', async () => {
    const fetchMock = jest.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: { role: string; content: string }[];
      };
      const user = body.messages.find((m) => m.role === 'user')!.content;
      const count = (user.match(/^\d+\./gm) ?? []).length;
      // в каждом батче помечаем шумом первую компанию
      return llmResponse(
        JSON.stringify({
          verdicts: Array.from({ length: count }, (_, j) => ({ i: j + 1, c: j === 0 ? 'B2C' : 'B2B' })),
        }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(81)); // 40+40+1
    // 3 классификации + 1 рефьют (3 кандидата в одном батче; категориальный
    // ответ мока не парсится как рефьют → флаги сохраняются)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect([...res.noise].sort((a, b) => a - b)).toEqual([0, 40, 80]);
    expect(res.classified).toBe(81);
  });

  it('кривой JSON батча — fail-open (все остаются), другие батчи работают', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(llmResponse('это не json'))
      .mockResolvedValueOnce(
        llmResponse(JSON.stringify({ verdicts: [{ i: 1, c: 'B2C' }] })),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(41)); // 40 + 1
    expect(res.failedBatches).toBe(1);
    expect([...res.noise]).toEqual([40]); // только из второго батча
  });

  it('терпит codefence-обёртку вокруг JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      llmResponse('```json\n{"verdicts":[{"i":1,"c":"B2C"}]}\n```'),
    ) as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(1));
    expect([...res.noise]).toEqual([0]);
  });

  it('игнорирует вердикты с i вне диапазона и дубликаты', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      llmResponse(
        JSON.stringify({
          verdicts: [
            { i: 0, c: 'B2C' }, // вне диапазона (нумерация с 1)
            { i: 5, c: 'B2C' }, // вне диапазона (всего 2)
            { i: 1, c: 'B2B' },
            { i: 1, c: 'B2C' }, // дубликат — игнор, первый вердикт главнее
            { i: 2, c: 'B2C' },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(2));
    expect([...res.noise]).toEqual([1]);
    expect(res.classified).toBe(2);
  });

  it('ступень 2: рефьют снимает флаг при noise:false и вызывается только по кандидатам', async () => {
    const fetchMock = jest.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages.find((m) => m.role === 'system')!.content;
      if (system.startsWith('Ты адвокат дьявола')) {
        // 2 кандидата: первого спасаем (B2B-ветка), второго подтверждаем шумом
        return llmResponse(JSON.stringify({ verdicts: [{ i: 1, noise: false }, { i: 2, noise: true }] }));
      }
      return llmResponse(
        JSON.stringify({
          verdicts: [
            { i: 1, c: 'B2C' },
            { i: 2, c: 'B2B' },
            { i: 3, c: 'GOV' },
          ],
        }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(3));
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 классификация + 1 рефьют
    expect([...res.noise]).toEqual([2]); // idx 0 спасён рефьютом, idx 2 подтверждён
    expect(res.refuted).toBe(1);
    // в рефьют ушли только 2 кандидата, не все 3 компании
    const refuteCall = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as {
      messages: { role: string; content: string }[];
    };
    expect(refuteCall.messages.find((m) => m.role === 'user')!.content).toContain('Кандидаты (2)');
  });

  it('ступень 2: сбой рефьюта СОХРАНЯЕТ флаг шума', async () => {
    const fetchMock = jest.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages.find((m) => m.role === 'system')!.content;
      if (system.startsWith('Ты адвокат дьявола')) {
        return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
      }
      return llmResponse(JSON.stringify({ verdicts: [{ i: 1, c: 'B2C' }] }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(1));
    expect([...res.noise]).toEqual([0]); // флаг не снят
    expect(res.refuted).toBe(0);
  });

  it('HTTP-ошибка после ретраев — fail-open, не бросает', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    } as unknown as Response) as unknown as typeof fetch;
    const res = await llmClassifyNoise(companies(2));
    expect(res.failedBatches).toBe(1);
    expect(res.noise.size).toBe(0);
  });
});
