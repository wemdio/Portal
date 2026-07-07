/** @jest-environment node */
/**
 * Failover + egress-block память при ТРЁХ probe-IP (прод крутит 3: 144:3100,
 * 144:3101, 89.19:3100). Проверяем, что переупорядочивание и каскад работают
 * не только на 2 прокси (аудит 05.07 отметил, что тесты были только на 2).
 * fetch мок URL-aware; DNS не трогаем.
 */

import type { DomainInfo, ValidationResult } from '@/lib/emailValidation/shared';

let validateEmail: (email: string, cache: Map<string, DomainInfo>) => Promise<ValidationResult>;
let resetEgressCache: () => void;
const fetchMock = jest.fn();

beforeAll(async () => {
  process.env.SMTP_PROXY_URLS = 'http://proxy-a.test:3100,http://proxy-b.test:3101,http://proxy-c.test:3102';
  delete process.env.SMTP_PROXY_URL;
  global.fetch = fetchMock as unknown as typeof fetch;
  const mod = await import('@/lib/emailValidation/validator');
  validateEmail = mod.validateEmail;
  resetEgressCache = mod.__resetEgressBlockCache;
});

beforeEach(() => {
  fetchMock.mockReset();
  resetEgressCache();
});

const INCONCL = { code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ETIMEDOUT' };
const OK = { code: 250, exists: true, isCatchAll: false, greylist: false };
const json = (p: unknown) => Promise.resolve({ ok: true, json: async () => p });
function cacheWith(domain: string): Map<string, DomainInfo> {
  return new Map([[domain, {
    domain, mxHosts: [`mx.${domain}`], mxFound: true,
    isCatchAll: false, isDisposable: false, checkedAt: new Date(),
  }]]);
}

describe('3 probe-IP: failover-каскад + память слепых', () => {
  it('два IP слепы к MX → каскад до рабочего; следующая проба идёт СРАЗУ на рабочий', async () => {
    // proxy-a и proxy-b «слепы» к mx.corp.ru (транспортный сбой), proxy-c рабочий
    fetchMock.mockImplementation((url) => json(String(url).includes('proxy-c') ? OK : INCONCL));

    // проба 1: каскад a→b→c, оба слепых помечаются
    const r1 = await validateEmail('u1@corp.ru', cacheWith('corp.ru'));
    expect(r1.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3); // прошли все три

    // проба 2 к тому же MX: proxy-c пробуется ПЕРВЫМ (a,b понижены) → 1 вызов
    fetchMock.mockClear();
    const r2 = await validateEmail('u2@corp.ru', cacheWith('corp.ru'));
    expect(r2.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1); // без 2×8с-простоя на слепых
    expect(String(fetchMock.mock.calls[0][0])).toContain('proxy-c');
  });

  it('все три IP не достучались → unknown (не invalid), все три испробованы', async () => {
    fetchMock.mockImplementation(() => json(INCONCL));
    const res = await validateEmail('u@corp.ru', cacheWith('corp.ru'));
    expect(res.result).toBe('unknown');
    expect(res.mx_found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // покрытие не теряем — пробуем всё
  });
});
