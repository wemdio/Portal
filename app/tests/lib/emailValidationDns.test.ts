/**
 * @jest-environment node
 *
 * Regression tests for the DNS/MX failure handling in the email validator.
 *
 * Bug (audit P0): a TRANSIENT resolver failure (SERVFAIL / timeout / EAI_AGAIN)
 * was collapsed into "domain has no MX" → result 'invalid' → cached 24h →
 * base-constructor deleted the row. That silently removed valid leads — the
 * exact client complaint. A transient failure must become a retryable 'unknown'
 * (kept), and must NOT be cached; only an AUTHORITATIVE no-MX/no-A is 'invalid'.
 */

const mockResolveMx = jest.fn();
const mockResolve4 = jest.fn();
// ОС-резолвер (системные DNS) — fallback после исчерпания ретраев пиннутого.
const mockOsResolveMx = jest.fn();
const mockOsResolve4 = jest.fn();

jest.mock('dns', () => {
  class Resolver {
    setServers() {}
    resolveMx(domain: string) { return mockResolveMx(domain); }
    resolve4(domain: string) { return mockResolve4(domain); }
    resolve6() { return Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })); }
  }
  return { promises: {
    Resolver,
    resolveMx: (domain: string) => mockOsResolveMx(domain),
    resolve4: (domain: string) => mockOsResolve4(domain),
  } };
});

import { lookupMX, validateEmail, classifyRcpt5xx } from '@/lib/emailValidation/validator';
import type { DomainInfo } from '@/lib/emailValidation/shared';

const dnsErr = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  mockResolveMx.mockReset();
  mockResolve4.mockReset();
  mockOsResolveMx.mockReset();
  mockOsResolve4.mockReset();
  // По умолчанию ОС-резолвер тоже «мёртв»; кейсы, где он спасает, задают его явно.
  mockOsResolveMx.mockRejectedValue(dnsErr('ESERVFAIL'));
  mockOsResolve4.mockRejectedValue(dnsErr('ESERVFAIL'));
});

describe('lookupMX — transient vs authoritative DNS errors', () => {
  it('real MX records → found, not failed', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mx.a.ru', priority: 10 }]);
    expect(await lookupMX('a.ru')).toEqual({ mxHosts: ['mx.a.ru'], found: true, lookupFailed: false });
  });

  it('transient SERVFAIL (after retries) → lookupFailed, NOT a no-MX verdict', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ESERVFAIL'));
    expect(await lookupMX('flaky.example')).toEqual({ mxHosts: [], found: false, lookupFailed: true });
    expect(mockResolveMx).toHaveBeenCalledTimes(3); // retried
  });

  it('transient ETIMEDOUT → lookupFailed', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ETIMEDOUT'));
    expect((await lookupMX('slow.example')).lookupFailed).toBe(true);
  });

  it('authoritative ENOTFOUND + no A record → not found, not failed (genuinely dead)', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ENOTFOUND'));
    mockResolve4.mockRejectedValue(dnsErr('ENOTFOUND'));
    expect(await lookupMX('dead.example')).toEqual({ mxHosts: [], found: false, lookupFailed: false });
  });

  it('no MX but A record exists → implicit MX (RFC 5321)', async () => {
    mockResolveMx.mockResolvedValue([]);
    mockResolve4.mockResolvedValue(['1.2.3.4']);
    expect(await lookupMX('a-only.example')).toEqual({ mxHosts: ['a-only.example'], found: true, lookupFailed: false });
  });

  it('ENOTFOUND on MX but the A lookup itself soft-fails → lookupFailed (do not condemn)', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ENOTFOUND'));
    mockResolve4.mockRejectedValue(dnsErr('ESERVFAIL'));
    expect((await lookupMX('ambiguous.example')).lookupFailed).toBe(true);
  });
});

describe('lookupMX — fallback на ОС-резолвер (системные DNS)', () => {
  it('пиннутый резолвер молчит, ОС-резолвер вернул MX → found, один OS-вызов за lookup', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ESERVFAIL'));
    mockOsResolveMx.mockReset();
    mockOsResolveMx.mockResolvedValue([{ exchange: 'mx.os.ru', priority: 10 }]);
    expect(await lookupMX('os-saved.example')).toEqual({ mxHosts: ['mx.os.ru'], found: true, lookupFailed: false });
    expect(mockOsResolveMx).toHaveBeenCalledTimes(1); // ровно одна OS-попытка, не ретрай
  });

  it('пиннутый молчит, у ОС нет MX, но есть A-запись → implicit MX', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ETIMEDOUT'));
    mockOsResolveMx.mockReset();
    mockOsResolveMx.mockResolvedValue([]);
    mockOsResolve4.mockReset();
    mockOsResolve4.mockResolvedValue(['1.2.3.4']);
    expect(await lookupMX('os-a.example')).toEqual({ mxHosts: ['os-a.example'], found: true, lookupFailed: false });
  });

  it('оба резолвера мертвы → lookupFailed (unknown, не invalid)', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ESERVFAIL'));
    // ОС-резолвер по beforeEach-дефолту тоже отвечает ESERVFAIL
    expect((await lookupMX('both-dead.example')).lookupFailed).toBe(true);
  });

  it('пиннутый резолвер ответил — ОС-резолвер НЕ дёргается', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mx.a.ru', priority: 10 }]);
    expect((await lookupMX('direct.example')).found).toBe(true);
    expect(mockOsResolveMx).not.toHaveBeenCalled();
  });
});

describe('classifyRcpt5xx — genuine "user unknown" vs policy/rate-limit 5xx', () => {
  it('Yandex "550 5.7.1 No such user!" → invalid (user-unknown text wins over the 5.7.1 policy code)', () => {
    expect(classifyRcpt5xx('550 5.7.1 No such user! 1782325033-abc')).toBe('invalid');
  });
  it('Gmail "550 5.1.1 ... NoSuchUser" → invalid', () => {
    expect(classifyRcpt5xx('550 5.1.1 https://support.google.com/mail/?p=NoSuchUser')).toBe('invalid');
  });
  it('common user-unknown phrasings → invalid', () => {
    expect(classifyRcpt5xx('550 mailbox unavailable')).toBe('invalid');
    expect(classifyRcpt5xx('550 recipient rejected')).toBe('invalid');
    expect(classifyRcpt5xx('550 user not found')).toBe('invalid');
    expect(classifyRcpt5xx('550 5.1.10 RESOLVER.ADR.RecipNotFound')).toBe('invalid');
  });
  it('«мягкие» user-unknown формулировки С policy-словами → unknown (политика, не мёртвый ящик)', () => {
    // Exchange Online: тот же "Recipient address rejected", но это policy-блок
    expect(classifyRcpt5xx('550 5.4.1 Recipient address rejected: Access denied')).toBe('unknown');
    expect(classifyRcpt5xx('550 5.4.1 mailbox unavailable, access denied by policy')).toBe('unknown');
    expect(classifyRcpt5xx('550 recipient rejected by local policy')).toBe('unknown');
  });
  it('числовой код сужен: 5.1.1/5.1.10 → invalid, прочие 5.1.x без user-unknown текста → НЕ invalid', () => {
    expect(classifyRcpt5xx('550 5.1.1 User unknown')).toBe('invalid');
    // 5.1.2/5.1.3 (bad destination/system address) без явного текста — не «user unknown»
    expect(classifyRcpt5xx('550 5.1.2 Bad destination system address')).toBe('invalid'); // нет policy-слов — default invalid
    expect(classifyRcpt5xx('550 5.1.0 Sender rejected')).toBe('unknown'); // анти-проба по отправителю
  });
  it('rate-limit / policy 5xx → unknown (do NOT delete — keep as unverifiable)', () => {
    expect(classifyRcpt5xx('550 5.7.1 too many connections, try again later')).toBe('unknown');
    expect(classifyRcpt5xx('554 5.7.1 Service unavailable; client host blocked')).toBe('unknown');
    expect(classifyRcpt5xx('550 5.7.1 Access denied by policy')).toBe('unknown');
    expect(classifyRcpt5xx('421 greylisted, please retry')).toBe('unknown');
  });
  it('bare 5xx with no recognizable text or missing text → invalid (preserve default)', () => {
    expect(classifyRcpt5xx('550 Requested action aborted')).toBe('invalid');
    expect(classifyRcpt5xx('')).toBe('invalid');
    expect(classifyRcpt5xx(undefined)).toBe('invalid');
  });
});

describe('validateEmail — DNS failure verdict mapping', () => {
  it('transient SERVFAIL → unknown (NOT invalid) and the domain is NOT cached', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ESERVFAIL'));
    const cache = new Map<string, DomainInfo>();
    const r = await validateEmail('user@flaky-dns-domain.example', cache);
    expect(r.result).toBe('unknown');
    expect(r.quality).toBe('risky');
    expect(cache.size).toBe(0); // negative NOT persisted → no 24h domain poisoning
  });

  it('authoritative no MX / no A → invalid (this is a real dead domain)', async () => {
    mockResolveMx.mockRejectedValue(dnsErr('ENOTFOUND'));
    mockResolve4.mockRejectedValue(dnsErr('ENOTFOUND'));
    const r = await validateEmail('user@really-dead-domain.example', new Map());
    expect(r.result).toBe('invalid');
    expect(r.mx_found).toBe(false);
  });
});
