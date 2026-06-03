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

  it('extracts year from JSON-LD foundingDate (most reliable source)', () => {
    const html = `<script type="application/ld+json">{"@type":"Organization","name":"Acme","foundingDate":"2007-03-15"}</script>`;
    expect(extractFoundedYear(html)).toBe(2007);
  });

  it('extracts year from microdata itemprop="foundingDate" content/datetime/value', () => {
    expect(extractFoundedYear(`<meta itemprop="foundingDate" content="2011">`)).toBe(2011);
    expect(extractFoundedYear(`<time itemprop="foundingDate" datetime="2013-08-20">2013</time>`)).toBe(2013);
  });

  it('extracts year from short-form "Founded 2015" without "in"', () => {
    expect(extractFoundedYear(`<p>Founded 2015</p>`)).toBe(2015);
  });

  it('extracts year from "Year founded: 2020" / "Год основания: 2020"', () => {
    expect(extractFoundedYear(`<p>Year founded: 2020</p>`)).toBe(2020);
    expect(extractFoundedYear(`<p>Год основания — 2019</p>`)).toBe(2019);
  });

  it('derives founding year from "N лет на рынке" / "10 years in business"', () => {
    const currentYear = new Date().getFullYear();
    expect(extractFoundedYear(`<p>Более 15 лет на рынке</p>`)).toBe(currentYear - 15);
    expect(extractFoundedYear(`<p>10 years in business</p>`)).toBe(currentYear - 10);
    expect(extractFoundedYear(`<p>Опыт работы более 12 лет</p>`)).toBe(currentYear - 12);
  });

  it('rejects derived years older than 50 years (would imply pre-1975 founding)', () => {
    // "Более 80 лет" is rarely true and almost always marketing copy.
    expect(extractFoundedYear(`<p>Более 80 лет на рынке</p>`)).toBeUndefined();
  });
});
