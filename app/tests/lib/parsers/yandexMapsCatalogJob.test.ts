/** @jest-environment node */

/**
 * Каталожные задачи Яндекс.Карт для инструментов («Парсер репутации», DFYB,
 * Telegram-агент).
 *
 * Инструменты больше не должны создавать живых задач парсинга: конфиг
 * обязан нести catalog_filters и пустой search_urls — иначе воркер уйдёт
 * в живой сбор ссылок, ради отключения которого эти функции и написаны.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import {
  queueYandexMapsCatalogJob,
  runYandexMapsCatalogJobInline,
} from '@/lib/parsers/yandexMapsCatalogJob';
import { fillYandexMapsCatalogJobInChunks } from '@/lib/parsers/yandexMapsCatalog';
import type { YandexMapsCatalogFilters } from '@/lib/parsers/yandexMapsCatalog';

const fillChunks = fillYandexMapsCatalogJobInChunks as unknown as jest.Mock;

let mockDb: MockSupabaseClient = createMockSupabase({ tables: { yandex_maps_jobs: [] } });

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/parsers/yandexMapsCatalog', () => ({
  fillYandexMapsCatalogJobInChunks: jest.fn(),
}));

const FILTERS: YandexMapsCatalogFilters = { cities: ['Москва'], categories: ['стоматология'] };

beforeEach(() => {
  mockDb = createMockSupabase({ tables: { yandex_maps_jobs: [] } });
  fillChunks.mockReset();
});

describe('queueYandexMapsCatalogJob', () => {
  it('ставит pending-задачу с каталогными фильтрами и без поисковых URL', async () => {
    const jobId = await queueYandexMapsCatalogJob('user-1', FILTERS, 5000);

    expect(mockDb.getRows('yandex_maps_jobs')).toEqual([
      expect.objectContaining({
        id: jobId,
        user_id: 'user-1',
        status: 'pending',
        progress_stage: 'pending',
        config: { search_urls: [], catalog_filters: FILTERS, max_results: 5000, headless: true },
      }),
    ]);
  });
});

describe('runYandexMapsCatalogJobInline', () => {
  it('заполняет задачу каталогом и завершает её с количеством организаций', async () => {
    fillChunks.mockImplementation(async (_jobId, _filters, _limit, onProgress) => {
      await onProgress?.(50);
      return { organizations: 120 };
    });
    const onJobCreated = jest.fn();
    const onProgress = jest.fn();

    const result = await runYandexMapsCatalogJobInline('user-1', FILTERS, null, { onJobCreated, onProgress });

    expect(result.organizations).toBe(120);
    const [jobId, filters, limit] = fillChunks.mock.calls[0];
    expect(filters).toEqual(FILTERS);
    expect(limit).toBeNull();
    expect(onJobCreated).toHaveBeenCalledWith(result.jobId);
    expect(onProgress).toHaveBeenCalledWith(50);

    expect(mockDb.getRows('yandex_maps_jobs')[0]).toEqual(expect.objectContaining({
      id: jobId,
      status: 'completed',
      progress_stage: 'catalog_completed',
      total_organizations: 120,
      processed_organizations: 120,
    }));
  });

  it('пустая выдача помечает каталог пустым, а не ошибкой', async () => {
    fillChunks.mockResolvedValue({ organizations: 0 });

    const result = await runYandexMapsCatalogJobInline('user-1', FILTERS, 5000);

    expect(result.organizations).toBe(0);
    expect(mockDb.getRows('yandex_maps_jobs')[0]).toEqual(expect.objectContaining({
      status: 'completed',
      progress_stage: 'catalog_empty',
    }));
  });

  it('падение сбора оставляет задачу в истории с причиной', async () => {
    fillChunks.mockRejectedValue(new Error('каталог недоступен'));

    await expect(runYandexMapsCatalogJobInline('user-1', FILTERS, null)).rejects.toThrow('каталог недоступен');

    expect(mockDb.getRows('yandex_maps_jobs')[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error_message: 'каталог недоступен',
    }));
  });
});
