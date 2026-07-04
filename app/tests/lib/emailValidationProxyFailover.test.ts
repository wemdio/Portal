/** @jest-environment node */
/**
 * Failover между probe-IP: два прокси = разные исходящие IP со взаимно
 * дополняющими слепыми зонами (напр. новый IP слеп к Yandex, старый — к части
 * других MX). Стратегия — НЕ round-robin, а failover: если один IP не смог
 * достучаться до MX (timeout/refused/reject на нашем уровне), тот же адрес
 * повторяется через следующий прокси. Реальный ответ о ящике (exists/catch-all/
 * greylist) НЕ дублируется на второй IP.
 *
 * fetch мокается пофазно; DNS не трогаем (domainCache предзаполнен).
 */

import type { DomainInfo, ValidationResult } from '@/lib/emailValidation/shared';

type SmtpPayload = {
  code: number;
  exists: boolean | null;
  isCatchAll: boolean | null;
  greylist: boolean;
  smtpText?: string;
  error?: string;
};

let validateEmail: (email: string, cache: Map<string, DomainInfo>) => Promise<ValidationResult>;
const fetchMock = jest.fn();

beforeAll(async () => {
  // Два прокси = два исходящих IP.
  process.env.SMTP_PROXY_URLS = 'http://proxy-a.test:3100,http://proxy-b.test:3101';
  delete process.env.SMTP_PROXY_URL;
  global.fetch = fetchMock as unknown as typeof fetch;
  ({ validateEmail } = await import('@/lib/emailValidation/validator'));
});

beforeEach(() => {
  fetchMock.mockReset();
});

function reply(payload: SmtpPayload) {
  return { ok: true, json: async () => payload };
}

function cacheWith(domain: string, isCatchAll: boolean | null): Map<string, DomainInfo> {
  return new Map([[domain, {
    domain, mxHosts: [`mx.${domain}`], mxFound: true,
    isCatchAll, isDisposable: false, checkedAt: new Date(),
  }]]);
}

describe('failover между probe-IP', () => {
  it('IP-A не достучался до MX (timeout) → повтор через IP-B, который подтверждает ящик', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ETIMEDOUT 1.2.3.4:25' }))
      .mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: null, greylist: false }));
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2); // A → B failover
  });

  it('IP-A сразу дал ответ (ящик существует) → IP-B НЕ дёргается', async () => {
    fetchMock.mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1); // без лишнего вызова
  });

  it('IP-A дал 5xx «user unknown» (реальный ответ) → НЕ failover, остаётся invalid', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ code: 550, exists: false, isCatchAll: null, greylist: false, smtpText: '550 5.1.1 No such user' }))
      .mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    const res = await validateEmail('dead@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1); // реальный вердикт не переспрашиваем на другом IP
  });

  it('greylist — реальный временный ответ, НЕ дублируется на IP-B', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ code: 451, exists: null, isCatchAll: null, greylist: true }))
      .mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('greylist');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('оба IP заблокированы MX → unknown с транспортной ошибкой (не invalid)', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ETIMEDOUT' }))
      .mockResolvedValueOnce(reply({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ECONNREFUSED' }));
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('unknown');
    expect(res.mx_found).toBe(true); // домен жив, просто не смогли достучаться
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
