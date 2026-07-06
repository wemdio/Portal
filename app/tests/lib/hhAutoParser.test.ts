/**
 * Unit test for deriveDomain — единственная чистая функция в hhAutoParser,
 * остальное это сетевой ввод-вывод (HH API), который под integration-тест,
 * не unit. Domain-нормализацию тестируем плотно, потому что она потом идёт
 * в endpoint клиента: ошибка нормализации = промах в скоринг.
 */

import { deriveDomain, cleanHhDescription } from '@/lib/jobs/hhAutoParser';

describe('cleanHhDescription', () => {
  it('undefined/пустое → undefined', () => {
    expect(cleanHhDescription(undefined)).toBeUndefined();
    expect(cleanHhDescription('')).toBeUndefined();
    expect(cleanHhDescription('   ')).toBeUndefined();
  });

  it('вычищает HTML-теги и схлопывает пробелы', () => {
    expect(cleanHhDescription('<p>Мы <b>интегратор</b>&nbsp;1С</p>\n  для бизнеса')).toBe(
      'Мы интегратор 1С для бизнеса',
    );
  });

  it('обрезает до 400 символов с многоточием', () => {
    const long = 'а'.repeat(500);
    const out = cleanHhDescription(long)!;
    expect(out.length).toBe(401); // 400 + …
    expect(out.endsWith('…')).toBe(true);
  });

  it('чистый текст без тегов проходит как есть', () => {
    expect(cleanHhDescription('Разработка ПО для банков')).toBe('Разработка ПО для банков');
  });
});

describe('deriveDomain', () => {
  it('returns null for null input', () => {
    expect(deriveDomain(null)).toBeNull();
  });

  it('strips https:// scheme', () => {
    expect(deriveDomain('https://example.com')).toBe('example.com');
  });

  it('strips http:// scheme', () => {
    expect(deriveDomain('http://example.com')).toBe('example.com');
  });

  it('adds implicit https when scheme is missing', () => {
    expect(deriveDomain('example.com')).toBe('example.com');
  });

  it('strips leading www.', () => {
    expect(deriveDomain('https://www.example.com')).toBe('example.com');
  });

  it('lowercases the domain', () => {
    expect(deriveDomain('https://EXAMPLE.COM/contacts')).toBe('example.com');
  });

  it('strips path, query, hash', () => {
    expect(deriveDomain('https://example.com/about?utm=1#section')).toBe('example.com');
  });

  it('preserves subdomain other than www', () => {
    expect(deriveDomain('https://shop.example.com')).toBe('shop.example.com');
  });

  it('returns null for malformed input that throws on URL parse', () => {
    expect(deriveDomain('not a url at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(deriveDomain('')).toBeNull();
  });
});
