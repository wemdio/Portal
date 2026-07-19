import {
  CLIENT_LOCALES,
  CLIENT_LOCALE_STORAGE_KEY,
  getClientTranslation,
  normalizeClientLocale,
  readClientLocaleCookie,
  resolveDemoClientLocale,
} from '@/lib/clientI18n';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';
import { CLIENT_TRANSLATION_CATALOGS } from '@/lib/clientTranslations.generated';

describe('clientI18n', () => {
  test('exposes only the three supported client locales', () => {
    expect(CLIENT_LOCALES).toEqual(['ru', 'en', 'es']);
  });

  test.each([
    ['ru', 'ru'],
    ['en', 'en'],
    ['es', 'es'],
    ['de', 'ru'],
    [null, 'ru'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeClientLocale(input)).toBe(expected);
  });

  test('uses a namespaced browser-storage key', () => {
    expect(CLIENT_LOCALE_STORAGE_KEY).toBe('outreachos:client-locale');
  });

  test('reads the shared landing/app locale cookie', () => {
    expect(readClientLocaleCookie('x=1; outreachos-client-locale=es; y=2')).toBe('es');
    expect(readClientLocaleCookie('outreachos-client-locale=de')).toBeNull();
    expect(readClientLocaleCookie('x=1')).toBeNull();
  });

  test('opens demo in the locale persisted by the landing', () => {
    const emptyStorage = { getItem: () => null };
    expect(resolveDemoClientLocale(
      emptyStorage,
      'outreachos-client-locale=es',
      'en-US',
    )).toBe('es');
  });

  test('keeps an explicit demo choice ahead of cookie and browser language', () => {
    const storage = { getItem: () => 'en' };
    expect(resolveDemoClientLocale(
      storage,
      'outreachos-client-locale=es',
      'ru-RU',
    )).toBe('en');
  });

  test.each([
    ['en', 'Кампании', 'Campaigns'],
    ['es', 'Кампании', 'Campañas'],
    ['en', 'Смотреть демо', 'View demo'],
    ['es', 'Смотреть демо', 'Ver demo'],
  ] as const)('translates known UI copy to %s', (locale, source, expected) => {
    expect(getClientTranslation(source, locale)).toBe(expected);
  });

  test('preserves surrounding whitespace from React text nodes', () => {
    expect(getClientTranslation('  Кампании\n', 'es')).toBe('  Campañas\n');
  });

  test('supports generated templates while preserving runtime values', () => {
    expect(
      getClientTranslation(
        'Лимит 1 000 строк. В файле 1 234 строк.',
        'en',
      ),
    ).toBe('Limit: 1 000 rows. The file contains 1 234 rows.');
  });

  test('does not translate unknown client-authored content', () => {
    expect(getClientTranslation('Проект Альфа для Испании', 'es')).toBeNull();
  });

  test('Russian is the source locale and never produces a replacement', () => {
    expect(getClientTranslation('Кампании', 'ru')).toBeNull();
  });

  test.each(['en', 'es'] as const)('%s catalog covers the complete client UI without Cyrillic fallbacks', (locale) => {
    const values = Object.values(CLIENT_TRANSLATION_CATALOGS[locale]);
    expect(values.length).toBeGreaterThanOrEqual(1_900);
    expect(values.every((value) => !/[А-Яа-яЁё]/.test(value))).toBe(true);
  });

  test.each([
    ['/client', 'en', 'Campaigns'],
    ['/client', 'es', 'Campañas'],
    ['/client/dashboard', 'es', 'Panel'],
    ['/client/auto-pipeline/setup', 'es', 'Configurar secuencias'],
  ] as const)('localizes the browser title for %s in %s', (pathname, locale, title) => {
    expect(getPortalPageSectionTitle(pathname, locale)).toBe(title);
  });
});
