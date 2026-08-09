/** @jest-environment node */

import type { NextRequest } from 'next/server';

/**
 * Запуск поиска по каталогу забирает всё, что нашлось: потолка в 50 000 больше
 * нет, а объём — необязательное ограничение.
 *
 * Где выполняется сбор, решается по запрошенному объёму, без предварительного
 * счёта: `limit N` останавливается, набрав N строк, поэтому небольшое N всегда
 * быстрое и делается прямо в запросе. Без потолка объём заранее неизвестен —
 * такой сбор уходит воркеру, потому что шлюз рвёт HTTP-соединение через
 * 60 секунд, а организаций может оказаться и миллион.
 */

const mockFill = jest.fn();
const mockGetUser = jest.fn();
const jobs: Array<Record<string, unknown>> = [];

jest.mock('@/lib/parsers/yandexMapsCatalog', () => {
  const actual = jest.requireActual('@/lib/parsers/yandexMapsCatalog');
  return { ...actual, fillJobFromYandexMapsCatalog: (...args: unknown[]) => mockFill(...args) };
});

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('@/lib/auth/blockDemo', () => ({ blockDemo: async () => null }));
jest.mock('@/lib/cryptoGcm', () => ({ encryptJsonAes256Gcm: () => 'encrypted' }));

/** Мини-заглушка supabase: insert кладёт строку, update патчит её на месте. */
function makeClient() {
  return {
    auth: { getUser: () => mockGetUser() },
    from: (table: string) => {
      if (table !== 'yandex_maps_jobs') throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          const job = { id: 'job-1', ...row };
          jobs.push(job);
          return { select: () => ({ single: async () => ({ data: job, error: null }) }) };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (_column: string, id: string) => {
            const job = jobs.find((item) => item.id === id);
            if (job) Object.assign(job, patch);
            return {
              select: () => ({ single: async () => ({ data: job, error: null }) }),
              // update без .select() тоже должен резолвиться (ветка ошибки).
              then: (resolve: (value: unknown) => unknown) => resolve({ data: job, error: null }),
            };
          },
        }),
      };
    },
  };
}

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'token',
  createAuthedSupabaseClient: () => makeClient(),
}));

function request(body: unknown) {
  return new Request('http://x/api/parsers/yandexmaps', {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  jobs.length = 0;
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  mockFill.mockResolvedValue({ organizations: 1200, links: 1200 });
});

describe('POST /api/parsers/yandexmaps', () => {
  it('без объёма забирает всё и отдаёт сбор воркеру', async () => {
    const { POST } = await import('@/app/api/parsers/yandexmaps/route');
    const response = await POST(request({
      catalog_filters: { cities: ['Москва'], categories: ['Кафе'], countries: ['Россия'] },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
    expect(body.job.status).toBe('pending');
    // В запросе ничего не собирали: объём неизвестен, там может быть миллион.
    expect(mockFill).not.toHaveBeenCalled();
    // И потолок в конфиг не подставляли — воркер должен забрать всё.
    expect((body.job.config as { max_results: unknown }).max_results).toBeNull();
  });

  it('небольшой объём собирается прямо в запросе и возвращается готовым', async () => {
    const { POST } = await import('@/app/api/parsers/yandexmaps/route');
    const response = await POST(request({
      catalog_filters: { cities: ['Москва'], categories: ['Кафе'], countries: ['Россия'] },
      max_results: 3000,
    }));

    expect(response.status).toBe(200);
    const { job } = await response.json();
    expect(job.status).toBe('completed');
    expect(job.total_organizations).toBe(1200);
    expect(job.completed_at).toBeTruthy();

    expect(mockFill).toHaveBeenCalledTimes(1);
    expect(mockFill.mock.calls[0][0]).toBe('job-1');
    expect(mockFill.mock.calls[0][2]).toBe(3000);
    // В очереди задача не оставалась ни на миг.
    expect(jobs[0].status).not.toBe('pending');
  });

  it('объём больше порога уходит в очередь, а не собирается в запросе', async () => {
    const { POST } = await import('@/app/api/parsers/yandexmaps/route');
    const response = await POST(request({
      catalog_filters: { cities: ['Москва'], categories: ['Магазин продуктов'] },
      max_results: 200000,
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
    expect(body.job.status).toBe('pending');
    expect(mockFill).not.toHaveBeenCalled();
    // Запрошенный потолок доезжает до воркера как есть.
    expect((body.job.config as { max_results: unknown }).max_results).toBe(200000);
  });

  it('объём из кабинета передаётся в отбор', async () => {
    const { POST } = await import('@/app/api/parsers/yandexmaps/route');
    await POST(request({
      catalog_filters: { cities: ['Москва'], categories: ['Кафе'] },
      max_results: 500,
    }));
    expect(mockFill.mock.calls[0][2]).toBe(500);
  });

  it('упавший отбор оставляет задачу в истории с причиной', async () => {
    mockFill.mockRejectedValue(new Error('каталог недоступен'));
    const { POST } = await import('@/app/api/parsers/yandexmaps/route');
    const response = await POST(request({
      catalog_filters: { cities: ['Москва'] },
      max_results: 3000,
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'каталог недоступен' });
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].error_message).toBe('каталог недоступен');
  });

  it('запуск по ссылкам по-прежнему уходит в очередь воркера', async () => {
    const { POST } = await import('@/app/api/parsers/yandexmaps/route');
    const response = await POST(request({ search_urls: ['https://yandex.ru/maps/?text=Москва'] }));

    expect(response.status).toBe(200);
    const { job } = await response.json();
    expect(job.status).toBe('pending');
    expect(mockFill).not.toHaveBeenCalled();
  });
});
