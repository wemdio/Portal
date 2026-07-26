/** @jest-environment node */

import {
  TWO_GIS_CSV_COLUMNS,
  createTwoGisCsvPreamble,
  serializeTwoGisCsvRows,
} from '@/lib/twoGis/csv';

describe('2GIS CSV', () => {
  it('keeps the exact 14 source columns and Excel separator preamble', () => {
    expect(TWO_GIS_CSV_COLUMNS).toEqual([
      'id',
      'name',
      'city_name',
      'geometry_name',
      'post_code',
      'phone',
      'email',
      'website',
      'vkontakte',
      'instagram',
      'lon',
      'lat',
      'category',
      'subcategory',
    ]);

    const preamble = createTwoGisCsvPreamble();
    expect(preamble.startsWith('\uFEFFsep=;\r\n')).toBe(true);
    expect(preamble).toContain('"id";"name";"city_name"');
  });

  it('preserves long IDs and quotes semicolons, quotes and embedded newlines', () => {
    const csv = serializeTwoGisCsvRows([
      {
        id: '4504127908669251',
        name: 'Кафе "Волна"; филиал',
        city_name: 'Москва',
        geometry_name: 'улица Первая,\nдом 2',
        post_code: '001234',
        phone: '+74950000000',
        email: 'hello@example.ru',
        website: 'https://example.ru',
        vkontakte: '',
        instagram: '',
        lon: '37.61',
        lat: '55.75',
        category: 'Еда',
        subcategory: 'Кафе',
      },
    ]);

    expect(csv).toContain('"\'4504127908669251"');
    expect(csv).toContain('"\'001234"');
    expect(csv).toContain('"Кафе ""Волна""; филиал"');
    expect(csv).toContain('"улица Первая,\nдом 2"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('neutralizes formulas and preserves phones and coordinates as spreadsheet-safe values', () => {
    const csv = serializeTwoGisCsvRows([
      {
        id: '1',
        name: '=HYPERLINK("https://evil.example")',
        phone: '+7 (495) 000-00-00',
        website: '@SUM(1+1)',
        lon: '-37.61',
      },
    ]);

    expect(csv).toContain('"\'=HYPERLINK(""https://evil.example"")"');
    expect(csv).toContain('"\'@SUM(1+1)"');
    expect(csv).toContain(`"'+7 (495) 000-00-00"`);
    expect(csv).toContain('"-37.61"');
  });
});
