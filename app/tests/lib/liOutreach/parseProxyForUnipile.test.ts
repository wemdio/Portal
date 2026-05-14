/**
 * Контракты parseProxyForUnipile. Главное — поддержка ВСЕХ четырёх форматов
 * после жалобы специалиста «не получается привязать прокси к аккаунту
 * Никиты». До фикса карточка аккаунта принимала только ip:port:user:pass
 * (split с lenght === 4), а юзер копировал http://user:pass@host:port
 * → split давал 5 сегментов → throw → 502.
 */
import { parseProxyForUnipile } from '@/lib/liOutreach/unipileClient';

describe('parseProxyForUnipile', () => {
  it('parses http://user:pass@host:port', () => {
    expect(parseProxyForUnipile('http://VtVmt51R:7GnJr2Yb@154.81.199.122:63310')).toEqual({
      host: '154.81.199.122',
      port: 63310,
      username: 'VtVmt51R',
      password: '7GnJr2Yb',
      protocol: 'http',
    });
  });

  it('parses https:// as http (Unipile only knows http tunnel)', () => {
    expect(parseProxyForUnipile('https://u:p@1.2.3.4:8080').protocol).toBe('http');
  });

  it('URL-decodes username and password with special chars', () => {
    expect(parseProxyForUnipile('http://u%40s:p%23ass@1.2.3.4:8080')).toMatchObject({
      username: 'u@s',
      password: 'p#ass',
    });
  });

  it('parses user:pass@host:port without scheme', () => {
    expect(parseProxyForUnipile('user:pass@1.2.3.4:8080')).toEqual({
      host: '1.2.3.4',
      port: 8080,
      username: 'user',
      password: 'pass',
      protocol: 'http',
    });
  });

  it('parses host:port:user:pass (4 segments)', () => {
    expect(parseProxyForUnipile('154.81.199.122:63310:VtVmt51R:7GnJr2Yb')).toEqual({
      host: '154.81.199.122',
      port: 63310,
      username: 'VtVmt51R',
      password: '7GnJr2Yb',
      protocol: 'http',
    });
  });

  it('handles password with colons in 4+ segment form', () => {
    expect(parseProxyForUnipile('1.2.3.4:8080:user:p:a:s:s')).toMatchObject({
      username: 'user',
      password: 'p:a:s:s',
    });
  });

  it('parses anonymous host:port', () => {
    expect(parseProxyForUnipile('1.2.3.4:8080')).toEqual({
      host: '1.2.3.4',
      port: 8080,
      protocol: 'http',
    });
  });

  it('throws on empty / unparsable strings', () => {
    expect(() => parseProxyForUnipile('')).toThrow();
    expect(() => parseProxyForUnipile('not-a-proxy')).toThrow();
    expect(() => parseProxyForUnipile('http://no-port-host')).toThrow();
  });
});
