/** @jest-environment node */

import { normalizeHeMarket, serperGeoForMarket, defaultChainLanguageForMarket, projectMarket } from '@/lib/hypothesisEngine/market';

const mockSerperSearch = jest.fn(async (_q?: string, _opts?: unknown) => [] as Array<{ title: string; link: string }>);
jest.mock('@/lib/search/serperClient', () => ({
  serperSearch: (q: string, opts?: unknown) => mockSerperSearch(q, opts),
}));

describe('HeMarket helpers', () => {
  it('normalizes unknown/empty values to ru (backwards compatible default)', () => {
    expect(normalizeHeMarket('us')).toBe('us');
    expect(normalizeHeMarket('ru')).toBe('ru');
    expect(normalizeHeMarket(undefined)).toBe('ru');
    expect(normalizeHeMarket(null)).toBe('ru');
    expect(normalizeHeMarket('gb')).toBe('ru');
  });

  it('maps market to Serper geo params', () => {
    expect(serperGeoForMarket('us')).toEqual({ gl: 'us', hl: 'en' });
    expect(serperGeoForMarket('ru')).toEqual({ gl: 'ru', hl: 'ru' });
  });

  it('derives the default chain language from the market', () => {
    expect(defaultChainLanguageForMarket('us')).toBe('en');
    expect(defaultChainLanguageForMarket('ru')).toBe('ru');
  });

  it('reads the market off a project row (missing column tolerated)', () => {
    expect(projectMarket({ market: 'us' })).toBe('us');
    expect(projectMarket({})).toBe('ru');
    expect(projectMarket({ market: null })).toBe('ru');
  });
});

describe('defaultSearch geo wiring', () => {
  beforeEach(() => mockSerperSearch.mockClear());

  it('passes us/en to Serper for market=us', async () => {
    const { defaultSearch } = await import('@/lib/hypothesisEngine/stages/searchIo');
    await defaultSearch('crm for dentists', 'us');
    expect(mockSerperSearch).toHaveBeenCalledWith('crm for dentists', expect.objectContaining({ gl: 'us', hl: 'en' }));
  });

  it('keeps ru/ru as the default (no market given)', async () => {
    const { defaultSearch } = await import('@/lib/hypothesisEngine/stages/searchIo');
    await defaultSearch('crm для стоматологий');
    expect(mockSerperSearch).toHaveBeenCalledWith('crm для стоматологий', expect.objectContaining({ gl: 'ru', hl: 'ru' }));
  });
});

describe('resolveNavMarket (host precedence over profile)', () => {
  it('eng host always wins, regardless of profile market', async () => {
    const { resolveNavMarket } = await import('@/lib/engMarket');
    expect(resolveNavMarket('app.outreachos.xyz', 'ru')).toBe('eng');
    expect(resolveNavMarket('app.outreachos.xyz', undefined)).toBe('eng');
    expect(resolveNavMarket('app.outreachos.xyz', 'eng')).toBe('eng');
  });

  it('off the eng host the profile decides (default ru)', async () => {
    const { resolveNavMarket } = await import('@/lib/engMarket');
    expect(resolveNavMarket('polza-portal.ru', 'eng')).toBe('eng');
    expect(resolveNavMarket('polza-portal.ru', 'ru')).toBe('ru');
    expect(resolveNavMarket('polza-portal.ru', null)).toBe('ru');
    expect(resolveNavMarket(null, null)).toBe('ru');
  });
});
