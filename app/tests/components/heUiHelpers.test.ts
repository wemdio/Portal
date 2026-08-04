/**
 * Tests for hypothesis-engine UI host/name formatters (components/hypothesis-engine/ui.tsx).
 *
 *   prettyHost('https://www.acme.com/') -> 'acme.com'
 *   prettyHost(punycode URL)            -> Unicode domain (IDN decode)
 *   prettyProjectName                   -> decodes legacy punycode names, keeps plain names
 */

import { prettyHost, prettyProjectName } from '@/components/hypothesis-engine/ui';

describe('prettyHost', () => {
  it('strips scheme and www', () => {
    expect(prettyHost('https://www.acme.com/')).toBe('acme.com');
  });

  it('decodes a punycode IDN host to Unicode', () => {
    expect(prettyHost('https://xn--e1aaaapoody9c2a6al5c.xn--p1ai/')).toBe('цельныерешения.рф');
  });

  it('keeps a regular host untouched', () => {
    expect(prettyHost('https://polzaagency.ru/')).toBe('polzaagency.ru');
  });
});

describe('prettyProjectName', () => {
  it('falls back to the site host when the name is empty', () => {
    expect(prettyProjectName('  ', 'https://acme.com/')).toBe('acme.com');
    expect(prettyProjectName(null, 'https://acme.com/')).toBe('acme.com');
  });

  it('decodes a legacy punycode name', () => {
    expect(
      prettyProjectName('xn--e1aaaapoody9c2a6al5c.xn--p1ai', 'https://xn--e1aaaapoody9c2a6al5c.xn--p1ai/'),
    ).toBe('цельныерешения.рф');
  });

  it('keeps a human-entered name as is', () => {
    expect(prettyProjectName('Цельные Решения', 'https://цельныерешения.рф/')).toBe(
      'Цельные Решения',
    );
  });

  it('does not mangle names that merely contain "xn--" inside text', () => {
    expect(prettyProjectName('Проект xn--test клиента', 'https://acme.com/')).toBe(
      'Проект xn--test клиента',
    );
  });
});
