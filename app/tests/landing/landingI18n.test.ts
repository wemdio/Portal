import fs from 'node:fs';
import path from 'node:path';

// The landing runtime is intentionally framework-free because Timeweb serves it
// as a static page.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeLocale, translateText } = require('../../../landing/i18n.js') as {
  normalizeLocale: (value: unknown) => 'ru' | 'en' | 'es';
  translateText: (
    source: string,
    locale: 'ru' | 'en' | 'es',
    catalogs: Record<'en' | 'es', Record<string, string>>,
  ) => string | null;
};

describe('landing localization runtime', () => {
  const catalogs = {
    en: { 'Смотреть демо': 'View demo' },
    es: { 'Смотреть демо': 'Ver demo' },
  };

  it('supports only the public RU, EN and ES locales', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('ES_es')).toBe('es');
    expect(normalizeLocale('fr')).toBe('ru');
  });

  it('uses exact bundled translations and preserves whitespace', () => {
    expect(translateText('  Смотреть демо\n', 'en', catalogs)).toBe('  View demo\n');
    expect(translateText('Смотреть демо', 'es', catalogs)).toBe('Ver demo');
    expect(translateText('Client campaign name', 'en', catalogs)).toBeNull();
    expect(translateText('Смотреть демо', 'ru', catalogs)).toBeNull();
  });

  it('ships the language control, shared locale scripts and current app links', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), '../landing/index.html'), 'utf8');

    expect(html).toContain('data-language-switcher');
    expect(html).toContain('data-lang="ru"');
    expect(html).toContain('data-lang="en"');
    expect(html).toContain('data-lang="es"');
    expect(html).toContain('src="translations.generated.js"');
    expect(html).toContain('src="i18n.js"');
    expect(html).toContain('https://app.outreachos.pro/client');
    expect(html).not.toContain('https://polza-portal.ru/');
  });
});
