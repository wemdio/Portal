/** @jest-environment node */

import {
  buildTwoGisCountQuery,
  buildTwoGisSearchQuery,
  normalizeTwoGisFilters,
} from '@/lib/twoGis/query';

describe('2GIS query core', () => {
  it('normalizes supported filters and removes empty values', () => {
    expect(
      normalizeTwoGisFilters({
        cities: [' Москва ', '', 'Москва', 'Казань'],
        categories: ['Еда'],
        subcategories: ['Кафе'],
        name: '  кофе  ',
        hasPhone: true,
        hasEmail: false,
        hasWebsite: true,
        hasVkontakte: true,
        hasInstagram: true,
      }),
    ).toEqual({
      cities: ['Москва', 'Казань'],
      categories: ['Еда'],
      subcategories: ['Кафе'],
      name: 'кофе',
      hasPhone: true,
      hasEmail: false,
      hasWebsite: true,
      hasVkontakte: true,
      hasInstagram: true,
    });
  });

  it('uses the same parameterized filters for count and search', () => {
    const malicious = `Москва'); drop table cards; --`;
    const filters = normalizeTwoGisFilters({
      cities: [malicious],
      categories: ['Медицина'],
      hasPhone: true,
      name: 'центр',
    });

    const count = buildTwoGisCountQuery(filters);
    const search = buildTwoGisSearchQuery(filters, { limit: 100, cursor: '4500000000000000' });

    expect(count.text).not.toContain(malicious);
    expect(search.text).not.toContain(malicious);
    expect(count.params).toContainEqual([malicious]);
    expect(search.params).toContainEqual([malicious]);
    expect(count.text).toContain('city_name = ANY');
    expect(search.text).toContain('city_name = ANY');
    expect(count.text).toContain('has_phone = true');
    expect(search.text).toContain('has_phone = true');
  });

  it('uses stable keyset pagination and clamps the preview limit', () => {
    const query = buildTwoGisSearchQuery(normalizeTwoGisFilters({}), {
      limit: 1000,
      cursor: '4500000000000000',
    });

    expect(query.text).toMatch(/id\s*>\s*\$\d+/i);
    expect(query.text).toMatch(/order by id asc/i);
    expect(query.text).toMatch(/limit\s+\$\d+/i);
    expect(query.text).not.toMatch(/\boffset\b/i);
    expect(query.params.at(-1)).toBe(200);
  });

  it('treats percent and underscore in a name as literal characters', () => {
    const query = buildTwoGisCountQuery(
      normalizeTwoGisFilters({ name: '100%_кофе' }),
    );

    expect(query.text).toMatch(/ilike\s+\$\d+\s+escape/i);
    expect(query.params).toContain('%100\\%\\_кофе%');
  });

  it('matches a selected subcategory through normalized membership', () => {
    const query = buildTwoGisCountQuery(
      normalizeTwoGisFilters({ subcategories: ['Стоматологии'] }),
    );

    expect(query.text).toMatch(/public\.card_subcategories/i);
    expect(query.text).toMatch(/card_id\s*=\s*cards\.id/i);
    expect(query.params).toContainEqual(['Стоматологии']);
  });
});
