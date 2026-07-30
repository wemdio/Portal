/**
 * Пул прокси для email-скрапера.
 *
 * Инцидент 30.07.2026: с 21.07 скрапер ходит на сайты через PROXY_URLS
 * (коммит c7226712). Доля строк, упавших в таймаут 60с, выросла 5.4% → 32.9%,
 * среднее число попыток 1.07 → 1.76, медиана строки 30с → 44с — сбор базы на
 * 1000 строк стал занимать час вместо 20 минут.
 *
 * Причина: мёртвый или перегруженный IP не отвечает, запрос висит до общего
 * таймаута, и запасной прямой запрос уже не успевает. Отсюда правила:
 *   1) прокси-попытке — отдельный короткий бюджет, остаток идёт на прямой запрос;
 *   2) IP, который несколько раз подряд не ответил, временно выводится из ротации;
 *   3) EMAIL_SCRAPER_PROXY=0 — мгновенный откат на прямые запросы без деплоя.
 */

import {
  isProxyEnabled,
  pickProxyUrl,
  proxyAttemptTimeoutMs,
  reportProxyResult,
  __resetProxyPool,
} from '@/lib/enrich/proxyPool';

const P1 = 'http://user:pass@1.1.1.1:8000';
const P2 = 'http://user:pass@2.2.2.2:8000';
const P3 = 'http://user:pass@3.3.3.3:8000';

describe('proxyPool', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.PROXY_URLS = JSON.stringify([P1, P2, P3]);
    delete process.env.EMAIL_SCRAPER_PROXY;
    delete process.env.EMAIL_SCRAPER_PROXY_TIMEOUT_MS;
    delete process.env.EMAIL_SCRAPER_PROXY_EJECT_MS;
    __resetProxyPool();
  });

  afterAll(() => {
    process.env = envBackup;
  });

  it('rotates through every configured proxy', () => {
    const picked = [pickProxyUrl(), pickProxyUrl(), pickProxyUrl()];
    expect(new Set(picked)).toEqual(new Set([P1, P2, P3]));
  });

  it('parses a comma-separated list too', () => {
    process.env.PROXY_URLS = `${P1}, ${P2}`;
    __resetProxyPool();
    expect(new Set([pickProxyUrl(), pickProxyUrl()])).toEqual(new Set([P1, P2]));
  });

  it('goes direct when the kill switch is set', () => {
    process.env.EMAIL_SCRAPER_PROXY = '0';
    __resetProxyPool();
    expect(isProxyEnabled()).toBe(false);
    expect(pickProxyUrl()).toBe('');
  });

  it('goes direct when no proxies are configured', () => {
    process.env.PROXY_URLS = '';
    __resetProxyPool();
    expect(pickProxyUrl()).toBe('');
  });

  it('ejects a proxy after three consecutive failures', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) reportProxyResult(P1, false, now);

    const picked = new Set([
      pickProxyUrl(now),
      pickProxyUrl(now),
      pickProxyUrl(now),
      pickProxyUrl(now),
    ]);
    expect(picked).not.toContain(P1);
    expect(picked).toEqual(new Set([P2, P3]));
  });

  it('lets an ejected proxy back in after the cooldown', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) reportProxyResult(P1, false, now);
    expect(new Set([pickProxyUrl(now), pickProxyUrl(now)])).not.toContain(P1);

    const later = now + 6 * 60_000;
    const picked = new Set([pickProxyUrl(later), pickProxyUrl(later), pickProxyUrl(later)]);
    expect(picked).toContain(P1);
  });

  it('forgives a proxy that answers again before the third strike', () => {
    const now = 1_000_000;
    reportProxyResult(P1, false, now);
    reportProxyResult(P1, false, now);
    reportProxyResult(P1, true, now);
    reportProxyResult(P1, false, now);

    const picked = new Set([pickProxyUrl(now), pickProxyUrl(now), pickProxyUrl(now)]);
    expect(picked).toContain(P1);
  });

  it('falls back to direct when every proxy is dead', () => {
    const now = 1_000_000;
    for (const p of [P1, P2, P3]) {
      for (let i = 0; i < 3; i += 1) reportProxyResult(p, false, now);
    }
    expect(pickProxyUrl(now)).toBe('');
  });

  it('caps the proxy attempt well below the 60s row budget', () => {
    expect(proxyAttemptTimeoutMs()).toBeLessThanOrEqual(10_000);

    process.env.EMAIL_SCRAPER_PROXY_TIMEOUT_MS = '5000';
    __resetProxyPool();
    expect(proxyAttemptTimeoutMs()).toBe(5000);
  });
});
