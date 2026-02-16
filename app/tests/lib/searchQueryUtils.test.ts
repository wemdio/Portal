import { simplifySearchQuery } from '@/lib/parsers/searchQueryUtils';

describe('searchQueryUtils', () => {
  it('removes operators and quotes', () => {
    const query = 'site:ru "каталог компаний" intitle:контакты filetype:pdf';
    const simplified = simplifySearchQuery(query);
    expect(simplified).toContain('каталог компаний');
    expect(simplified).toContain('контакты');
    expect(simplified).not.toContain('site:');
    expect(simplified).not.toContain('intitle:');
    expect(simplified).not.toContain('filetype:');
  });

  it('normalizes plus and extra symbols', () => {
    const query = 'магазин подарков +контакты';
    const simplified = simplifySearchQuery(query);
    expect(simplified).toBe('магазин подарков контакты');
  });
});
