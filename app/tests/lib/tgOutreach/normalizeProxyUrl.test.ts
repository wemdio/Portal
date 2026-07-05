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

  // Провайдеры (Infatica, pool.proxy.market) экспортируют тип последним
  // сегментом: `host:port:user:pass:HTTP`. До фикса `HTTP` попадал в пароль
  // через `:`, и в БД уходил URL с `%3AHTTP` в user-info — на проде так утекло
  // 402 прокси в tg_outreach_proxies (кампании Лидген 3.0 и Profitsol 3.0).
  describe('trailing type suffix (HTTP/SOCKS4/SOCKS5)', () => {
    it('strips trailing :HTTP from host:port:user:pass:HTTP', () => {
      expect(normalizeProxyUrl('mobpool.proxy.market:10000:7JQO8UV8C6:2gFrv0aYGh:HTTP')).toBe(
        'http://7JQO8UV8C6:2gFrv0aYGh@mobpool.proxy.market:10000',
      );
    });

    it('strips trailing :SOCKS5 in lowercase too', () => {
      expect(normalizeProxyUrl('1.2.3.4:8080:user:pass:socks5')).toBe(
        'http://user:pass@1.2.3.4:8080',
      );
    });

    it('strips trailing :HTTPS', () => {
      expect(normalizeProxyUrl('1.2.3.4:8080:user:pass:HTTPS')).toBe(
        'http://user:pass@1.2.3.4:8080',
      );
    });

    it('does not strip :HTTP when it is not the last segment', () => {
      // Пароль реально «HTTP:something» — хвост уже не «просто HTTP».
      expect(normalizeProxyUrl('1.2.3.4:8080:user:HTTP:x')).toBe(
        'http://user:HTTP%3Ax@1.2.3.4:8080',
      );
    });

    it('does not strip when scheme already present', () => {
      // Если URL уже нормальный — не трогаем ничего, включая теоретический
      // trailing :HTTP (маловероятно, но контракт «есть ://» → сквозной).
      expect(normalizeProxyUrl('http://user:pass@1.2.3.4:8080')).toBe(
        'http://user:pass@1.2.3.4:8080',
      );
    });

    it('strips trailing type in host:port@user:pass form too', () => {
      expect(normalizeProxyUrl('pool.proxy.market:10989@user:pass:HTTP')).toBe(
        'http://user:pass@pool.proxy.market:10989',
      );
    });
  });

  it('returns empty string unchanged', () => {
    expect(normalizeProxyUrl('')).toBe('');
    expect(normalizeProxyUrl('   ')).toBe('');
  });

  // ---- host:port@user:pass (pool.proxy.market и аналоги) ------------------
  // Провайдер экспортирует строки вида `pool.proxy.market:10989@vvCcRyAQjR:Uifd2wsByc`,
  // где сначала host:port, потом учётка. Если оставить как
  // `http://host:port@user:pass`, то new URL() принимает строку, но трактует
  // host:port как userInfo, а user:pass как hostname:port — реальный коннект
  // уходит в никуда. Корректная нормализация — переставить стороны:
  // `http://user:pass@host:port`.
  describe('host:port@user:pass (reverse order from pool.proxy.market)', () => {
    it('flips sides into standard userinfo URL', () => {
      expect(normalizeProxyUrl('pool.proxy.market:10989@vvCcRyAQjR:Uifd2wsByc')).toBe(
        'http://vvCcRyAQjR:Uifd2wsByc@pool.proxy.market:10989',
      );
    });

    it('works with IP host too', () => {
      expect(normalizeProxyUrl('1.2.3.4:10989@user:pass')).toBe(
        'http://user:pass@1.2.3.4:10989',
      );
    });

    it('URL-encodes user/pass with special chars on flip', () => {
      expect(normalizeProxyUrl('1.2.3.4:8080@user:p#ss')).toBe(
        'http://user:p%23ss@1.2.3.4:8080',
      );
    });

    it('handles missing pass (only user after @) without throwing data away', () => {
      expect(normalizeProxyUrl('1.2.3.4:8080@username')).toBe(
        'http://username@1.2.3.4:8080',
      );
    });

    it('keeps standard user:pass@host:port (port on the right) untouched', () => {
      // Не путаем со старым форматом — там «:<число>» справа, значит userinfo
      // уже на своём месте и переставлять нельзя.
      expect(normalizeProxyUrl('user:pass@1.2.3.4:8080')).toBe(
        'http://user:pass@1.2.3.4:8080',
      );
    });
  });
});
