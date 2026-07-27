/** @jest-environment node */

import {
  parseTwoGisFilters,
  TwoGisRequestError,
} from '@/app/api/tools/2gis-parser/_shared';

describe('2GIS request filters', () => {
  it('accepts grouped category and subcategory selections', () => {
    expect(
      parseTwoGisFilters({
        rubricGroups: [
          { category: ' Еда ', mode: 'all' },
          {
            category: 'Услуги',
            mode: 'some',
            subcategories: [' Ремонт ', 'Ремонт', 'Кафе'],
          },
        ],
      }),
    ).toEqual({
      rubricGroups: [
        { category: 'Еда', mode: 'all' },
        {
          category: 'Услуги',
          mode: 'some',
          subcategories: ['Ремонт', 'Кафе'],
        },
      ],
    });
  });

  it('accepts a whole category with explicit exclusions', () => {
    expect(
      parseTwoGisFilters({
        rubricGroups: [
          {
            category: ' Еда ',
            mode: 'allExcept',
            excludedSubcategories: [' Бары ', 'Бары', 'Кафе'],
          },
        ],
      }),
    ).toEqual({
      rubricGroups: [
        {
          category: 'Еда',
          mode: 'allExcept',
          excludedSubcategories: ['Бары', 'Кафе'],
        },
      ],
    });
  });

  it('rejects mixing grouped rubric filters with legacy category filters', () => {
    expect(() =>
      parseTwoGisFilters({
        categories: ['Еда'],
        rubricGroups: [{ category: 'Услуги', mode: 'all' }],
      }),
    ).toThrow(TwoGisRequestError);
  });

  it('rejects more than 200 grouped rubric selections', () => {
    expect(() =>
      parseTwoGisFilters({
        rubricGroups: [
          {
            category: 'Услуги',
            mode: 'some',
            subcategories: Array.from(
              { length: 201 },
              (_, index) => `Рубрика ${index}`,
            ),
          },
        ],
      }),
    ).toThrow(/200/);
  });

  it('rejects overlong values inside grouped rubric selections', () => {
    expect(() =>
      parseTwoGisFilters({
        rubricGroups: [
          { category: 'x'.repeat(301), mode: 'all' },
        ],
      }),
    ).toThrow(/short strings/i);
  });
});
