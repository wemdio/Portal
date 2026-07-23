import {
  mapPlatform,
  mapCategory,
} from '@/lib/leadsReport/platformMapper';

describe('mapPlatform', () => {
  it('yandex + cpc → Я.Директ', () => {
    expect(
      mapPlatform({
        source: 'yandex',
        medium: 'cpc',
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Я.Директ');
  });

  it('polzaagency / hh → HH', () => {
    expect(
      mapPlatform({
        source: 'polzaagency',
        medium: 'outreach',
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('HH');
    expect(
      mapPlatform({
        source: 'hh',
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('HH');
  });

  it('inst → Инстаграм', () => {
    expect(
      mapPlatform({
        source: 'inst',
        medium: 'social',
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Инстаграм');
  });

  it('vs / campaign contains vs → VS', () => {
    expect(
      mapPlatform({
        source: 'vs',
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('VS');
    expect(
      mapPlatform({
        source: 'x',
        medium: null,
        campaign: 'summer_vs_2026',
        content: null,
        term: null,
      }),
    ).toBe('VS');
  });

  it('пустой source → Органика', () => {
    expect(
      mapPlatform({
        source: null,
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Органика');
  });

  it('неизвестный source → Другое (source)', () => {
    expect(
      mapPlatform({
        source: 'reddit',
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Другое (reddit)');
  });
});

describe('mapCategory', () => {
  it.each([
    ['Я.Директ', 'Лиды Директ'],
    ['Инстаграм', 'Лиды Директ'],
    ['VK', 'Лиды Директ'],
    ['HH', 'Лиды копирайт'],
    ['Органика', 'Заявки органика'],
    ['VS', 'Лиды Директ'],
    ['Другое (reddit)', 'Заявки органика'],
  ])('%s → %s', (platform, expected) => {
    expect(mapCategory(platform)).toBe(expected);
  });
});
