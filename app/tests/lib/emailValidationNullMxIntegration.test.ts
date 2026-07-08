/** @jest-environment node */
/**
 * Интеграционный тест null-MX: домен с RFC 7505 null MX ("MX 0 .") →
 * validateEmail возвращает 'invalid' (недоставляемо), НЕ 'unknown', и НЕ делает
 * SMTP-пробу и НЕ падает в fallback на A-запись. Мокаем DNS-резолвер валидатора.
 */

const mockResolveMx = jest.fn();
const mockResolve4 = jest.fn();

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
const fetchMock = jest.fn();

beforeAll(async () => {
  process.env.SMTP_PROXY_URLS = 'http://proxy-a.test:3100';
  global.fetch = fetchMock as unknown as typeof fetch;
  ({ validateEmail } = await import('@/lib/emailValidation/validator'));
});

beforeEach(() => {
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
