import { buildGoogleSearchUrl } from '@/lib/parsers/searchScraper';

describe('buildGoogleSearchUrl', () => {
  it('encodes query and applies defaults', () => {
    const url = buildGoogleSearchUrl('каталог магазинов подарков', { numResults: 10, hl: 'ru', gl: 'ru' });
    const parsed = new URL(url);
    expect(url).toContain('https://www.google.com/search?');
    expect(url).toContain('num=10');
    expect(url).toContain('hl=ru');
    expect(url).toContain('gl=ru');
    expect(parsed.searchParams.get('q')).toBe('каталог магазинов подарков');
  });
});

