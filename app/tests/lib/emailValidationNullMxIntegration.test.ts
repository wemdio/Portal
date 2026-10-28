/** @jest-environment node */
/**
 * Интеграционный тест null-MX: домен с RFC 7505 null MX ("MX 0 .") →
 * validateEmail возвращает 'invalid' (недоставляемо), НЕ 'unknown', и НЕ делает
 * SMTP-пробу и НЕ падает в fallback на A-запись. Мокаем DNS-резолвер валидатора.
 */

const mockResolveMx = jest.fn();
const mockResolve4 = jest.fn();

// In-memory stand-in for the two shared cache tables (sharedCache.ts).
const mockTables: Record<string, Map<string, Record<string, unknown>>> = {};
jest.mock('@/lib/supabaseAdmin', () => {
  const table = (name: string) => (mockTables[name] ??= new Map());
  const keyOf = (name: string) => (name === 'email_validation_result_cache' ? 'email' : 'domain');
  return {
    supabaseAdmin: {
      from: (name: string) => ({
        select: () => ({
          in: (_column: string, keys: string[]) => ({
            gt: async (_c: string, now: string) => ({ error: null,
              data: keys.map((key) => table(name).get(key)).filter((row) => row && String(row.expires_at) > now) }),
          }),
        }),
        upsert: async (rows: Array<Record<string, unknown>>) => {
          for (const row of rows) table(name).set(String(row[keyOf(name)]), row);
          return { error: null };
        },
        delete: () => ({ lt: async () => ({ error: null }) }),
      }),
    },
  };
});

jest.mock('dns', () => ({
  promises: {
    Resolver: jest.fn().mockImplementation(() => ({
      setServers: jest.fn(),
      resolveMx: mockResolveMx,
      resolve4: mockResolve4,
      resolve6: jest.fn(),
    })),
  },
}));

import type { DomainInfo, ValidationResult } from '@/lib/emailValidation/shared';

let validateEmail: (email: string, cache: Map<string, DomainInfo>) => Promise<ValidationResult>;
let resetEgress: () => void;
let cache: typeof import('@/lib/emailValidation/sharedCache');
const fetchMock = jest.fn();

beforeAll(async () => {
  process.env.SMTP_PROXY_URLS = 'http://proxy-a.test:3100';
  // Test domains (.test, Microsoft tenants) are Western destinations: the same proxy.
  process.env.SMTP_PROXY_URLS_WEST = 'http://proxy-a.test:3100';
  global.fetch = fetchMock as unknown as typeof fetch;
  ({ validateEmail, __resetEgressBlockCache: resetEgress } = await import('@/lib/emailValidation/validator'));
  cache = await import('@/lib/emailValidation/sharedCache');
});

beforeEach(() => {
  for (const name of Object.keys(mockTables)) mockTables[name].clear();
  cache.__resetSharedValidationCache();
  resetEgress();
  fetchMock.mockReset();
  mockResolveMx.mockReset();
  mockResolve4.mockReset();
});

describe('validateEmail: RFC 7505 null-MX домен', () => {
  it('null MX (exchange="") → invalid, БЕЗ SMTP-пробы', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: '', priority: 0 }]);
    // если бы код падал в A-fallback — resolve4 бы вернул "живой" A:
    mockResolve4.mockResolvedValue(['1.2.3.4']);

    const res = await validateEmail('user@nullmx.test', new Map());
    expect(res.result).toBe('invalid');
    expect(res.mx_found).toBe(false);
    expect(res.details.step).toBe('mx');
    expect(fetchMock).not.toHaveBeenCalled(); // никакой SMTP-пробы
    expect(mockResolve4).not.toHaveBeenCalled(); // НЕ упали в implicit-MX A-fallback
  });

  it('обычный MX → идёт на SMTP-пробу (контроль)', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mx.real.test', priority: 10 }]);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ code: 250, exists: true, isCatchAll: false, greylist: false }) });

    const res = await validateEmail('user@real.test', new Map());
    expect(res.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalled(); // проба состоялась
  });
});

const proxyAnswer = (body: Record<string, unknown>) => ({ ok: true, json: async () => body });
const sentBody = (call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;

describe('validateEmail: shared cache and fewer probes (23.10.2026, Spamhaus CSS)', () => {
  it('keeps a conclusive verdict for every later job and never keeps unknown', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mx.kept.test', priority: 10 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    expect((await validateEmail('Anna@Kept.test', new Map())).result).toBe('ok');
    await cache.flushSharedValidationCache();
    cache.__resetSharedValidationCache(); // another process: only the table remains
    const again = await validateEmail('anna@kept.test', new Map());
    expect(again.result).toBe('ok');
    expect(again.details.cache).toBe('hit');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 451, exists: null, isCatchAll: null, greylist: true, smtpText: '451 try later' }));
    expect((await validateEmail('greylisted@kept.test', new Map())).result).toBe('unknown');
    await cache.flushSharedValidationCache();
    expect(mockTables.email_validation_result_cache.has('greylisted@kept.test')).toBe(false);
  });

  it('reuses a domain catch-all flag: no random probe, and no probe at all on a catch-all domain', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mx.flag.test', priority: 10 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    await validateEmail('first@flag.test', new Map());
    expect(sentBody(0).checkCatchAll).toBe(true);
    await cache.flushSharedValidationCache();
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 250, exists: true, isCatchAll: null, greylist: false }));
    expect((await validateEmail('second@flag.test', new Map())).result).toBe('ok');
    expect(sentBody(1).checkCatchAll).toBe(false);

    mockResolveMx.mockResolvedValue([{ exchange: 'mxs.mail.ru', priority: 10 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 250, exists: true, isCatchAll: true, greylist: false }));
    expect((await validateEmail('one@mail.ru', new Map())).result).toBe('catch_all');
    await cache.flushSharedValidationCache();
    const calls = fetchMock.mock.calls.length;
    const known = await validateEmail('two@mail.ru', new Map());
    expect(known.result).toBe('catch_all');
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('a Spamhaus block at one Microsoft tenant stops probes to every tenant until it expires', async () => {
    mockResolveMx.mockResolvedValueOnce([{ exchange: 'acme-com.mail.protection.outlook.com', priority: 0 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 550, exists: false, isCatchAll: null, greylist: false,
      smtpText: '550 5.7.1 Service unavailable, Client host [31.76.79.220] blocked using Spamhaus' }));
    expect((await validateEmail('cfo@acme.com', new Map())).result).toBe('unknown');
    mockResolveMx.mockResolvedValueOnce([{ exchange: 'beta-io.mail.protection.outlook.com', priority: 0 }]);
    const skipped = await validateEmail('cto@beta.io', new Map());
    expect(skipped.result).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a transport failure at one tenant idles the IP for that host only', async () => {
    mockResolveMx.mockResolvedValueOnce([{ exchange: 'slow-com.mail.protection.outlook.com', priority: 0 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'SMTP connect timeout' }));
    expect((await validateEmail('a@slow.com', new Map())).result).toBe('unknown');
    mockResolveMx.mockResolvedValueOnce([{ exchange: 'fine-io.mail.protection.outlook.com', priority: 0 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    expect((await validateEmail('b@fine.io', new Map())).result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a proxy at its provider pace is busy, not blocked: the next probe goes out', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'aspmx.l.google.com', priority: 1 }]);
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'rate limited by proxy (google)' }));
    expect((await validateEmail('busy@paced.test', new Map())).result).toBe('unknown');
    fetchMock.mockResolvedValueOnce(proxyAnswer({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    expect((await validateEmail('later@paced.test', new Map())).result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
