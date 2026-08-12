/** @jest-environment node */

/**
 * Оценка пула 2GIS per сегмент: COUNT с statement_timeout в транзакции,
 * in-memory кэш (успех 24ч / сбой 10 мин), деградация → null без throw.
 */

jest.mock('server-only', () => ({}));

const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();
const connectMock = jest.fn();

jest.mock('@/lib/twoGisDataset', () => ({
  twoGisDatasetConnect: (...args: unknown[]) => connectMock(...args),
}));

import {
  estimateSegmentPool,
  estimateSegmentPools,
  resetPoolEstimateCache,
  POOL_ESTIMATE_STATEMENT_TIMEOUT_MS,
} from '@/lib/gisSignalOutreach/poolEstimates';

const RUBRIC = [
  {
    category: 'Юридические / финансовые / бизнес-услуги',
    includedSubcategories: ['Юридические услуги'],
  },
];

function sqlCalls(): string[] {
  return clientQueryMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolEstimateCache();
  connectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
  clientQueryMock.mockImplementation(async (text: string) => {
    if (String(text).includes('count(*)')) return { rows: [{ count: '12345' }] };
    return { rows: [] };
  });
});

describe('estimateSegmentPool', () => {
  it('COUNT под рубрикатором сегмента с has_website, в транзакции с SET LOCAL 15s', async () => {
    const estimate = await estimateSegmentPool('legal', RUBRIC);
    expect(estimate).toBe(12345);

    const calls = sqlCalls();
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe(`SET LOCAL statement_timeout = ${POOL_ESTIMATE_STATEMENT_TIMEOUT_MS}`);
    const countSql = calls[2];
    expect(countSql).toContain('count(*)');
    expect(countSql).toContain('has_website = true');
    // Рубрикатор ушёл в JOIN-подзапрос (как у pull-кандидатов пайплайна).
    expect(countSql).toContain('card_subcategories');
    expect(calls.at(-1)).toBe('COMMIT');
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
    // Параметры COUNT-запроса — категория и подрубрики сегмента.
    const countParams = (clientQueryMock.mock.calls[2][1] as unknown[]).flat();
    expect(countParams).toContain('Юридические / финансовые / бизнес-услуги');
    expect(countParams).toContain('Юридические услуги');
  });

  it('сбой/таймаут COUNT → null + ROLLBACK, наружу не бросаем', async () => {
    clientQueryMock.mockImplementation(async (text: string) => {
      if (String(text).includes('count(*)')) {
        throw new Error('canceling statement due to statement timeout');
      }
      return { rows: [] };
    });

    await expect(estimateSegmentPool('legal', RUBRIC)).resolves.toBeNull();
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('недоступный датасет (connect падает) → null без throw', async () => {
    connectMock.mockRejectedValue(new Error('TWOGIS_DATASET_DB_URL not configured'));
    await expect(estimateSegmentPool('legal', RUBRIC)).resolves.toBeNull();
  });

  it('успех кэшируется: повторный вызов без нового connect', async () => {
    await estimateSegmentPool('legal', RUBRIC);
    await estimateSegmentPool('legal', RUBRIC);
    expect(connectMock).toHaveBeenCalledTimes(1);

    resetPoolEstimateCache();
    await estimateSegmentPool('legal', RUBRIC);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('пустой рубрикатор → null без COUNT (не считаем «весь датасет»)', async () => {
    const estimate = await estimateSegmentPool('empty', []);
    expect(estimate).toBeNull();
    expect(sqlCalls().some((q) => q.includes('count(*)'))).toBe(false);
  });
});

describe('estimateSegmentPools', () => {
  it('оценки по всем сегментам одной картой, сбой одного не роняет остальные', async () => {
    clientQueryMock.mockImplementation(async (text: string, params?: unknown[]) => {
      if (String(text).includes('count(*)')) {
        // legal-запрос (подрубрика «Юридические услуги») падает, edu живёт.
        if ((params ?? []).flat().includes('Юридические услуги')) throw new Error('timeout');
        return { rows: [{ count: 777 }] };
      }
      return { rows: [] };
    });

    const map = await estimateSegmentPools([
      { key: 'edu', rubric_groups: [{ category: 'Образование', includedSubcategories: ['Языковые школы'] }] },
      { key: 'legal', rubric_groups: RUBRIC },
    ]);
    expect(map.get('edu')).toBe(777);
    expect(map.get('legal')).toBeNull();
  });
});
