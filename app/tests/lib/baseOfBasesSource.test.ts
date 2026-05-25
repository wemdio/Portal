import { describe, expect, test } from '@jest/globals';
import {
  cleanBobName,
  extractFirstWebsite,
  extractCityFromAddress,
  fetchTopUpFromBaseOfBases,
} from '@/lib/jobs/baseOfBasesSource';

describe('cleanBobName', () => {
  test('removes escaped quotes', () => {
    expect(cleanBobName('АО \\"ГРУППА КОМПАНИЙ \\"МЕДСИ\\"')).toBe(
      'АО "ГРУППА КОМПАНИЙ "МЕДСИ"',
    );
  });
  test('collapses repeated whitespace', () => {
    expect(cleanBobName('  Фуу   Барр  ')).toBe('Фуу Барр');
  });
  test('handles empty string', () => {
    expect(cleanBobName('')).toBe('');
  });
});

describe('extractFirstWebsite', () => {
  test('multi-value picks first', () => {
    expect(extractFirstWebsite('emcmos.ru, umg.com.cy, emc-beauty.ru')).toBe('https://emcmos.ru');
  });
  test('strips http:// prefix and re-adds https', () => {
    expect(extractFirstWebsite('http://example.com')).toBe('https://example.com');
  });
  test('strips trailing slash', () => {
    expect(extractFirstWebsite('example.com/')).toBe('https://example.com');
  });
  test('handles already-https', () => {
    expect(extractFirstWebsite('https://medsi.ru')).toBe('https://medsi.ru');
  });
  test('returns null for null/undefined/empty', () => {
    expect(extractFirstWebsite(null)).toBeNull();
    expect(extractFirstWebsite(undefined)).toBeNull();
    expect(extractFirstWebsite('')).toBeNull();
    expect(extractFirstWebsite('  ,  ')).toBeNull();
  });
});

describe('extractCityFromAddress', () => {
  test('extracts city after "г." prefix', () => {
    expect(extractCityFromAddress('123056, г. Москва, Грузинский пер., д. 3А')).toBe('Москва');
    expect(extractCityFromAddress('117246, г. Москва, Научный пр-д')).toBe('Москва');
  });
  test('returns null for address without г.', () => {
    expect(extractCityFromAddress('Без города')).toBeNull();
  });
  test('returns null for null/undefined', () => {
    expect(extractCityFromAddress(null)).toBeNull();
    expect(extractCityFromAddress(undefined)).toBeNull();
  });
});

describe('fetchTopUpFromBaseOfBases', () => {
  const sampleRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    inn: '7710641442',
    name: 'ООО "Тестовая компания"',
    website: 'test-company.ru',
    revenue: 50_000_000,
    address: '123456, г. Москва, ул. Тестовая, д. 1',
    okved_name: 'Тестовая деятельность',
    activity_type: 'Услуги',
    employees_count: 25,
    ...overrides,
  });

  test('returns empty if neededCount = 0', async () => {
    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 0,
      revenueFrom: 40_000_000,
      seenDomains: new Set(),
      excludePatterns: [],
      searchRowsImpl: async () => ({ rows: [sampleRow()] }),
    });
    expect(result.employers).toHaveLength(0);
    expect(result.scanned).toBe(0);
  });

  test('fetches exactly neededCount when source has enough', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      sampleRow({ id: i + 1, inn: String(7700000000 + i), website: `co${i}.ru`, name: `Co${i}` }),
    );
    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 10,
      revenueFrom: 40_000_000,
      seenDomains: new Set(),
      excludePatterns: [],
      batchSize: 50,
      searchRowsImpl: async () => ({ rows }),
    });
    expect(result.employers).toHaveLength(10);
    expect(result.employers[0].id).toBe('bob:7700000000');
    expect(result.employers[0].name).toBe('Co0');
    expect(result.employers[0].siteUrl).toBe('https://co0.ru');
  });

  /**
   * Helper: mock searchRows который возвращает заданные rows один раз, потом empty
   * (как реальная пагинация — после конца возвращает empty).
   */
  function singleBatchMock(rows: Record<string, unknown>[]) {
    let called = false;
    return async () => {
      if (called) return { rows: [] };
      called = true;
      return { rows };
    };
  }

  test('skips employers whose domain is in seenDomains', async () => {
    const rows = [
      sampleRow({ inn: '111', website: 'seen.ru', name: 'SeenCo' }),
      sampleRow({ inn: '222', website: 'fresh.ru', name: 'FreshCo' }),
    ];
    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 5,
      revenueFrom: 40_000_000,
      seenDomains: new Set(['seen.ru']),
      excludePatterns: [],
      batchSize: 50,
      searchRowsImpl: singleBatchMock(rows),
    });
    expect(result.employers).toHaveLength(1);
    expect(result.employers[0].name).toBe('FreshCo');
    expect(result.dedupSkipped).toBe(1);
  });

  test('skips employers matching excludePatterns', async () => {
    const rows = [
      sampleRow({ inn: '111', website: 'sber-co.ru', name: 'ООО Сбер-фабрика' }),
      sampleRow({ inn: '222', website: 'ok-co.ru', name: 'Нормальная компания' }),
    ];
    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 5,
      revenueFrom: 40_000_000,
      seenDomains: new Set(),
      excludePatterns: [/сбер/i],
      batchSize: 50,
      searchRowsImpl: singleBatchMock(rows),
    });
    expect(result.employers).toHaveLength(1);
    expect(result.employers[0].name).toBe('Нормальная компания');
    expect(result.excludeSkipped).toBe(1);
  });

  test('skips employers with no website', async () => {
    const rows = [
      sampleRow({ inn: '111', website: null, name: 'NoSite' }),
      sampleRow({ inn: '222', website: 'has.site', name: 'HasSite' }),
    ];
    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 5,
      revenueFrom: 40_000_000,
      seenDomains: new Set(),
      excludePatterns: [],
      batchSize: 50,
      searchRowsImpl: singleBatchMock(rows),
    });
    expect(result.employers).toHaveLength(1);
    expect(result.employers[0].name).toBe('HasSite');
    expect(result.noSiteSkipped).toBe(1);
  });

  test('paginates: requests more batches until needed satisfied', async () => {
    let calls = 0;
    const batch = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) =>
        sampleRow({
          inn: String(prefix + i),
          website: `${prefix}${i}.ru`,
          name: `${prefix}${i}`,
        }),
      );

    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 5,
      revenueFrom: 40_000_000,
      seenDomains: new Set(),
      excludePatterns: [],
      batchSize: 2,
      searchRowsImpl: async () => {
        calls++;
        if (calls > 3) return { rows: [] };
        return { rows: batch(2, `b${calls}_`) };
      },
    });
    expect(result.employers).toHaveLength(5);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test('stops at maxScanned even if needed unfulfilled', async () => {
    // All rows have domain 'dup.ru' — все будут skipped → набор не пополнится
    const result = await fetchTopUpFromBaseOfBases({
      neededCount: 100,
      revenueFrom: 40_000_000,
      seenDomains: new Set(['dup.ru']),
      excludePatterns: [],
      batchSize: 10,
      maxScanned: 30,
      searchRowsImpl: async () =>
        ({ rows: Array.from({ length: 10 }, () => sampleRow({ website: 'dup.ru' })) }),
    });
    expect(result.employers).toHaveLength(0);
    expect(result.scanned).toBeLessThanOrEqual(40); // не уходим в бесконечный цикл
  });
});
