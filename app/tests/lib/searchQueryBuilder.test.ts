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
  });

  describe('buildSearchQueries', () => {
    it('fills missing categories and returns 8 queries', () => {
      const queries = buildSearchQueries('', 'Маркетинговые агентства для SaaS');
      expect(queries).toHaveLength(8);
      expect(queries.every((q) => q.trim().length > 0)).toBe(true);
      expect(new Set(queries.map((q) => q.toLowerCase())).size).toBe(queries.length);
      expect(queries.some((q) => /(каталог|список|реестр|участник|тендер)/i.test(q))).toBe(true);
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
