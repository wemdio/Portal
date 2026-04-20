import { EXPORT_BASE_CATALOG } from '@/lib/projectBriefHypotheses/exportBaseCatalog';

describe('EXPORT_BASE_CATALOG snapshot', () => {
  it('не пустой и содержит хотя бы 100 записей', () => {
    expect(EXPORT_BASE_CATALOG.length).toBeGreaterThanOrEqual(100);
  });

  it('у каждой записи есть name, url, category', () => {
    for (const item of EXPORT_BASE_CATALOG) {
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(typeof item.category).toBe('string');
      expect(item.category.length).toBeGreaterThan(0);
      expect(item.url).toMatch(/^https:\/\/export-base\.ru\/+catalog_baz\//);
    }
  });

  it('нет дубликатов URL', () => {
    const urls = EXPORT_BASE_CATALOG.map((i) => i.url);
    const unique = new Set(urls);
    expect(unique.size).toBe(urls.length);
  });

  it('нет дубликатов имён внутри одной категории', () => {
    const seen = new Map<string, Set<string>>();
    for (const item of EXPORT_BASE_CATALOG) {
      const set = seen.get(item.category) ?? new Set<string>();
      expect(set.has(item.name)).toBe(false);
      set.add(item.name);
      seen.set(item.category, set);
    }
  });

  it('содержит хотя бы 4 различных категории', () => {
    const categories = new Set(EXPORT_BASE_CATALOG.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });

  it('имеет записи с ОКВЭД', () => {
    const hasOkved = EXPORT_BASE_CATALOG.some((i) => /ОКВЭД/i.test(i.name));
    expect(hasOkved).toBe(true);
  });

  it('имеет записи c маркетплейсами WB / OZON', () => {
    const hasMarketplace = EXPORT_BASE_CATALOG.some((i) => /(WB|OZON|WILDBERRIES|Wildberries)/i.test(i.name));
    expect(hasMarketplace).toBe(true);
  });
});
