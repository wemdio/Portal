import { flattenHhAreas, searchHhAreas, type HhAreaNode } from '@/lib/parsers/hhArchive/hhAreasLive';

const TREE: HhAreaNode = {
  id: 113,
  name: 'Россия',
  areas: [
    { id: 1, name: 'Москва' },
    {
      id: 53,
      name: 'Краснодарский край',
      areas: [
        { id: 237, name: 'Сочи' },
        { id: 1438, name: 'Сочинский район', areas: [{ id: 9999, name: 'Адлер' }] },
      ],
    },
  ],
};

describe('flattenHhAreas', () => {
  const flat = flattenHhAreas(TREE);

  it('flattens every node except the Россия root', () => {
    expect(flat).toHaveLength(5);
    expect(flat.find((h) => h.name === 'Россия')).toBeUndefined();
  });

  it('labels federal cities / top-level regions with empty region', () => {
    expect(flat.find((h) => h.id === '1')).toEqual({ id: '1', name: 'Москва', region: '' });
    expect(flat.find((h) => h.name === 'Краснодарский край')?.region).toBe('');
  });

  it('carries the top-level region down to nested descendants', () => {
    expect(flat.find((h) => h.name === 'Сочи')?.region).toBe('Краснодарский край');
    expect(flat.find((h) => h.name === 'Адлер')?.region).toBe('Краснодарский край');
  });

  it('stringifies numeric ids', () => {
    expect(flat.every((h) => typeof h.id === 'string')).toBe(true);
  });
});

describe('searchHhAreas', () => {
  const flat = flattenHhAreas(TREE);

  it('returns nothing for empty query', () => {
    expect(searchHhAreas(flat, '')).toEqual([]);
    expect(searchHhAreas(flat, '   ')).toEqual([]);
  });

  it('ranks exact match first, then prefix, shorter names before longer', () => {
    const hits = searchHhAreas(flat, 'соч');
    expect(hits[0].name).toBe('Сочи'); // prefix + shortest beats "Сочинский район"
  });

  it('finds federal cities by exact name', () => {
    expect(searchHhAreas(flat, 'москва')[0].id).toBe('1');
  });

  it('respects the limit', () => {
    expect(searchHhAreas(flat, 'край', 1)).toHaveLength(1);
  });
});
