/** @jest-environment node */

/**
 * Фоновый обход каталога: порядок шагов и цена ошибки в каждом.
 *
 * Что чинится. Обход состоит из полезной работы (найти новые организации и
 * записать их в каталог) и уборки (отметить, кого в выдаче не оказалось).
 * Уборка стояла ПЕРВОЙ и роняла всё задание, если не удавалась: 11.08.2026 на
 * бою 343 пары из 20 000 висели в «упало» с
 * `Не удалось отметить организации: The upstream server is timing out`, и ни
 * одной новой организации по ним не собралось. В очереди это самые крупные
 * пары — вся Москва среди них, — и они падали четвёртые сутки подряд.
 */

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('@/lib/loggerServer', () => ({
  logError: jest.fn(), logInfo: jest.fn(), logWarn: jest.fn(),
}));
jest.mock('@/lib/tracer', () => ({ startTrace: jest.fn(async () => null) }));
jest.mock('@/lib/parsers/yandexMapsCatalog', () => ({
  claimYandexMapsCatalogDiscovery: jest.fn(),
  filterUnknownYandexIds: jest.fn(),
  finishYandexMapsCatalogDiscovery: jest.fn(),
  markYandexMapsCatalogSeen: jest.fn(),
  recordYandexMapsCatalogRefreshCompleted: jest.fn(),
  upsertYandexMapsCatalogOrganizations: jest.fn(),
  normalizeYandexMapsCatalogFilters: jest.fn(),
  fillYandexMapsCatalogJobInChunks: jest.fn(),
  // Настоящий разбор ID из ссылки: на нём держится отсев известных.
  yandexIdFromCardUrl: (url: string) => url.match(/\/org\/(\d+)/)?.[1] ?? null,
}));
jest.mock('@/lib/parsers/yandexMapsServiceClient', () => ({
  yandexMapsHealth: jest.fn(),
  yandexMapsCollectLinksStream: jest.fn(),
  yandexMapsParseOrgs: jest.fn(),
  yandexMapsProxyCheck: jest.fn(),
  YandexMapsBlockedError: class extends Error {},
}));

import { logWarn } from '@/lib/loggerServer';
import { runYandexMapsCatalogDiscoveryBatch } from '@/lib/parsers/yandexMapsWorker';

const catalog = jest.requireMock('@/lib/parsers/yandexMapsCatalog') as Record<string, jest.Mock>;
const service = jest.requireMock('@/lib/parsers/yandexMapsServiceClient') as Record<string, jest.Mock>;

const TASK = { id: 7, country: 'Россия', place: 'Москва', rubric: 'Бизнес' };

/** Выдача Яндекса по паре «место × рубрика». */
function searchReturns(ids: string[]) {
  service.yandexMapsCollectLinksStream.mockImplementation(
    async (_payload: unknown, onChunk: (chunk: { links: string[] }) => void) => {
      onChunk({ links: ids.map((id) => `https://yandex.ru/maps/org/${id}`) });
      return { total: ids.length };
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  catalog.claimYandexMapsCatalogDiscovery.mockResolvedValue([TASK]);
  catalog.filterUnknownYandexIds.mockImplementation(async (ids: string[]) => new Set(ids));
  catalog.upsertYandexMapsCatalogOrganizations.mockImplementation(
    async (organizations: unknown[]) => organizations.length,
  );
  catalog.markYandexMapsCatalogSeen.mockResolvedValue(0);
  catalog.finishYandexMapsCatalogDiscovery.mockResolvedValue(undefined);
  catalog.recordYandexMapsCatalogRefreshCompleted.mockResolvedValue(undefined);
  service.yandexMapsHealth.mockResolvedValue(true);
  service.yandexMapsParseOrgs.mockImplementation(async ({ links }: { links: string[] }) => ({
    organizations: links.map((link) => ({ card_url: link, name: 'Организация' })),
  }));
  searchReturns(['1001', '1002']);
});

describe('фоновый обход каталога Яндекс.Карт', () => {
  it('новые организации собираются раньше уборки', async () => {
    const order: string[] = [];
    catalog.upsertYandexMapsCatalogOrganizations.mockImplementation(async (organizations: unknown[]) => {
      order.push('upsert');
      return organizations.length;
    });
    catalog.markYandexMapsCatalogSeen.mockImplementation(async () => {
      order.push('mark');
      return 0;
    });

    await runYandexMapsCatalogDiscoveryBatch();

    expect(order).toEqual(['upsert', 'mark']);
  });

  it('упавшая уборка не отменяет уже найденные организации', async () => {
    catalog.markYandexMapsCatalogSeen.mockRejectedValue(new Error('The upstream server is timing out'));

    await runYandexMapsCatalogDiscoveryBatch();

    // Две новые организации записаны в каталог...
    expect(catalog.upsertYandexMapsCatalogOrganizations).toHaveBeenCalled();
    // ...и задание закрыто как удачное, с их числом.
    const [id, stats] = catalog.finishYandexMapsCatalogDiscovery.mock.calls[0];
    expect(id).toBe(TASK.id);
    expect(stats).toMatchObject({ foundNew: 2, seenLinks: 2 });
    // Ошибки нет — значит пара вернётся в очередь как обычно, а не через сутки.
    expect(stats.error).toBeUndefined();
  });

  it('о неудачной уборке остаётся запись в логе', async () => {
    catalog.markYandexMapsCatalogSeen.mockRejectedValue(new Error('The upstream server is timing out'));

    await runYandexMapsCatalogDiscoveryBatch();

    expect(logWarn).toHaveBeenCalledWith(
      'parser.yandexmaps.catalog.mark_seen_failed',
      expect.any(String),
      expect.objectContaining({ place: TASK.place, rubric: TASK.rubric }),
    );
  });

  it('обрыв поиска по-прежнему валит задание — новых организаций из него нет', async () => {
    service.yandexMapsCollectLinksStream.mockRejectedValue(new Error('Page.goto: net::ERR_CONNECTION_RESET'));

    await runYandexMapsCatalogDiscoveryBatch();

    expect(catalog.finishYandexMapsCatalogDiscovery).toHaveBeenCalledWith(
      TASK.id,
      expect.objectContaining({ error: expect.stringContaining('ERR_CONNECTION_RESET') }),
    );
  });
});
