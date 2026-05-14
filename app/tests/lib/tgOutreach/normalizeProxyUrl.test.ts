/**
 * @jest-environment node
 *
 * Контракты normalizeProxyUrl. Главный кейс — поддержка популярного формата
 * host:port:user:pass, который экспортируют Proxy6/Infatica/AstroProxy.
 * Без этого фикса URL «http://1.2.3.4:8080:user:pass» хранился в БД успешно,
 * но gramClient.parseProxyUrl() не мог его распарсить и подключался без
 * прокси — кампании сразу банились.
 *
 * Pragma `@jest-environment node` обязательна: apiHelpers.ts импортирует
 * `NextResponse` из `next/server`, который тянет глобал `Request`. В дефолтном
 * jsdom-окружении (см. jest.config.js) глобал не определён, и тест падает
 * на этапе module resolution с `ReferenceError: Request is not defined`
 * ещё до запуска первого it().
 */
import { normalizeProxyUrl } from '@/lib/tgOutreach/apiHelpers';

describe('normalizeProxyUrl', () => {
  it('keeps explicit scheme as-is', () => {
    expect(normalizeProxyUrl('http://1.2.3.4:8080')).toBe('http://1.2.3.4:8080');
    expect(normalizeProxyUrl('socks5://user:pass@1.2.3.4:1080')).toBe(
      'socks5://user:pass@1.2.3.4:1080',
    );
    expect(normalizeProxyUrl('https://host.tld:8888')).toBe('https://host.tld:8888');
  });

  it('prefixes http:// to bare host:port', () => {
    expect(normalizeProxyUrl('1.2.3.4:8080')).toBe('http://1.2.3.4:8080');
  });

  it('prefixes http:// to user:pass@host:port', () => {
    expect(normalizeProxyUrl('user:pass@1.2.3.4:8080')).toBe(
      'http://user:pass@1.2.3.4:8080',
    );
  });

  it('converts host:port:user:pass to http://user:pass@host:port', () => {
    expect(normalizeProxyUrl('1.2.3.4:8080:user:pass')).toBe(
      'http://user:pass@1.2.3.4:8080',
    );
  });

  it('URL-encodes user/pass with non-@ special chars in the 4-segment form', () => {
    // Пароль с # и пробельными символами — встречается в провайдерах.
    // Без encodeURIComponent получился бы невалидный URL.
    //
    // NB: символ `@` в user/pass в 4-сегментной форме намеренно не поддерживаем
    // — иначе невозможно отличить `host:port:u@ser:pass` от формы
    // `user@host:port:pass`. Guard в normalizeProxyUrl: если в строке
    // встречается `@`, она парсится как `user:pass@host:port` (другая ветка).
    expect(normalizeProxyUrl('1.2.3.4:8080:user:p#ass')).toBe(
      'http://user:p%23ass@1.2.3.4:8080',
    );
  });

  it('does NOT treat host:port:something with non-numeric port as 4-segment', () => {
    // Это уже не host:port:user:pass — fallback к простому prefix.
    expect(normalizeProxyUrl('foo:bar:baz:qux')).toBe('http://foo:bar:baz:qux');
  });

  it('handles 5+ segments by joining tail into password', () => {
    // Пароль с двоеточием тоже встречается. host:port:user:p:a:s:s
    expect(normalizeProxyUrl('1.2.3.4:8080:user:p:a:s:s')).toBe(
      'http://user:p%3Aa%3As%3As@1.2.3.4:8080',
    );
  });

  it('returns empty string unchanged', () => {
    expect(normalizeProxyUrl('')).toBe('');
    expect(normalizeProxyUrl('   ')).toBe('');
  });
});
