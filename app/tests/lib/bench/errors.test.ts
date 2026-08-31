/** @jest-environment node */

import { benchError, BENCH_ERROR_STATUS } from '@/lib/bench/errors';

describe('bench errors', () => {
  it('отдаёт единую форму тела', async () => {
    const res = benchError('invalid_params', 'Параметр search_urls обязателен', {
      field: 'search_urls',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'invalid_params',
        message: 'Параметр search_urls обязателен',
        details: { field: 'search_urls' },
      },
    });
  });

  it('details по умолчанию null, а не отсутствует', async () => {
    const body = await benchError('not_found', 'Задача не найдена').json();
    expect(body.error.details).toBeNull();
  });

  it('чужая задача и отсутствующая неразличимы по коду ответа', () => {
    expect(BENCH_ERROR_STATUS.not_found).toBe(404);
  });

  it('оба вида превышения лимита дают 429', () => {
    expect(BENCH_ERROR_STATUS.rate_limited).toBe(429);
    expect(BENCH_ERROR_STATUS.quota_exceeded).toBe(429);
  });

  it('инструмент вне списка ключа — 403, а не 404', () => {
    // Здесь скрывать нечего: список инструментов ключа известен его владельцу
    // из GET /tools, и внятный отказ экономит ему часы догадок.
    expect(BENCH_ERROR_STATUS.tool_not_allowed).toBe(403);
  });
});
