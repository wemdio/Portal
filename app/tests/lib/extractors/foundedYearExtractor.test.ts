/** @jest-environment node */

import { extractFoundedYear } from '@/lib/enrich/extractors/foundedYearExtractor';

describe('extractFoundedYear', () => {
  it('extracts year from EN phrases like "Founded in 2015"', () => {
    expect(extractFoundedYear(`<p>We were founded in 2015</p>`)).toBe(2015);
    expect(extractFoundedYear(`<span>Established 2010</span>`)).toBe(2010);
    expect(extractFoundedYear(`<p>Since 2008</p>`)).toBe(2008);
  });

  it('extracts year from RU phrases like "Основана в 2018"', () => {
    expect(extractFoundedYear(`<p>Компания основана в 2018 году</p>`)).toBe(2018);
    expect(extractFoundedYear(`<p>На рынке с 2012 года</p>`)).toBe(2012);
    expect(extractFoundedYear(`<p>Работаем с 2009 года</p>`)).toBe(2009);
  });

  it('falls back to earliest year in copyright range "© 2010—2026"', () => {
    expect(extractFoundedYear(`<footer>© 2010—2026 Our Company</footer>`)).toBe(2010);
    expect(extractFoundedYear(`<footer>© 2014-2026 LLC</footer>`)).toBe(2014);
  });

  it('rejects unrealistic years (<1990 or >current+1)', () => {
    expect(extractFoundedYear(`<p>Established 1850</p>`)).toBeUndefined();
    expect(extractFoundedYear(`<p>Founded in 2199</p>`)).toBeUndefined();
  });

  it('returns undefined when no year-related phrase is found', () => {
    expect(extractFoundedYear(`<p>About our company</p>`)).toBeUndefined();
  });
});
