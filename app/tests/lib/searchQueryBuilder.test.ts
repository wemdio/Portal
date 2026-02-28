import { buildSearchQueries, parseSearchQueries } from '@/lib/parsers/searchQueryBuilder';

describe('searchQueryBuilder', () => {
  describe('parseSearchQueries', () => {
    it('parses strict JSON output', () => {
      const content = '{"queries":["one","two"]}';
      expect(parseSearchQueries(content)).toEqual(['one', 'two']);
    });

    it('parses JSON inside code fences', () => {
      const content = '```json\n{"queries":["first","second"]}\n```';
      expect(parseSearchQueries(content)).toEqual(['first', 'second']);
    });

    it('parses bullet list fallback', () => {
      const content = '- query one\n- query two';
      expect(parseSearchQueries(content)).toEqual(['query one', 'query two']);
    });

    it('drops JSON fragment lines when falling back to line parsing', () => {
      // Невалидный JSON (без ]}) — парсер переходит к построчному разбору
      const content = '{"queries": [\n  "каталог подарков",\n  "магазины подарков"';
      const parsed = parseSearchQueries(content);
      expect(parsed.every((q) => !/queries\s*":\s*\[/.test(q))).toBe(true);
      expect(parsed.some((q) => q.includes('каталог подарков') || q.includes('магазины подарков'))).toBe(true);
    });
  });

  describe('buildSearchQueries', () => {
    it('fills missing categories and returns 30 queries', () => {
      const queries = buildSearchQueries('', 'Маркетинговые агентства для SaaS');
      expect(queries).toHaveLength(30);
      expect(queries.every((q) => q.trim().length > 0)).toBe(true);
      expect(new Set(queries.map((q) => q.toLowerCase())).size).toBe(queries.length);
      expect(queries.some((q) => /(каталог|список|реестр|участник|тендер|выставк|конференц)/i.test(q))).toBe(false);
      expect(queries.some((q) => /сайт/i.test(q))).toBe(true);
      expect(queries.some((q) => /(директор|ceo|закупк|коммерческ)/i.test(q))).toBe(true);
    });

    it('drops non-cyrillic queries for russian brief', () => {
      const content = '{"queries":["gift store directory europe","каталог компаний подарков","official site"]}';
      const queries = buildSearchQueries(content, 'Каталог подарков Европа');
      expect(queries.every((q) => /[А-Яа-яЁё]/.test(q))).toBe(true);
    });
  });
});
