import { normalizeYandexOrgUrl, normalizeYandexOrgUrls } from '@/lib/parsers/yandexMapsUrlUtils';

describe('yandexMapsUrlUtils', () => {
  it('normalizes maps/org urls and strips suffixes', () => {
    expect(normalizeYandexOrgUrl('https://yandex.ru/maps/org/coffee/12345/reviews/')).toBe(
      'https://yandex.ru/maps/org/coffee/12345/',
    );
    expect(normalizeYandexOrgUrl('https://yandex.kz/maps/org/test/42/menu/')).toBe('https://yandex.ru/maps/org/test/42/');
  });

  it('normalizes /org/ urls into /maps/org/', () => {
    expect(normalizeYandexOrgUrl('https://yandex.ru/org/my_place/999')).toBe('https://yandex.ru/maps/org/my_place/999/');
    expect(normalizeYandexOrgUrl('https://yandex.com/org/foo/111/photos/')).toBe('https://yandex.ru/maps/org/foo/111/');
  });

  it('deduplicates urls case-insensitively', () => {
    const urls = normalizeYandexOrgUrls([
      'https://yandex.ru/maps/org/a/1/',
      'https://YANDEX.ru/maps/org/a/1/reviews/',
      'https://yandex.ru/maps/org/b/2/',
    ]);
    expect(urls).toEqual(['https://yandex.ru/maps/org/a/1/', 'https://yandex.ru/maps/org/b/2/']);
  });
});

