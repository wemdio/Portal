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
let resetEgressCache: () => void;
const fetchMock = jest.fn();

beforeAll(async () => {
  // Два прокси = два исходящих IP.
  process.env.SMTP_PROXY_URLS = 'http://proxy-a.test:3100,http://proxy-b.test:3101';
  delete process.env.SMTP_PROXY_URL;
  global.fetch = fetchMock as unknown as typeof fetch;
  const mod = await import('@/lib/emailValidation/validator');
  validateEmail = mod.validateEmail;
  resetEgressCache = mod.__resetEgressBlockCache;
});

beforeEach(() => {
  fetchMock.mockReset();
  resetEgressCache(); // память слепых IP не должна течь между кейсами
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

describe('память слепых IP (устраняет 8с-простой при round-robin)', () => {
  it('после обучения (IP-A слеп к MX) следующая проба к тому же MX идёт СРАЗУ на IP-B', async () => {
    // проба 1: IP-A таймаут → failover на IP-B; IP-A помечается слепым для mx.corp.ru
    fetchMock
      .mockResolvedValueOnce(reply({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ETIMEDOUT' }))
      .mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    await validateEmail('user1@corp.ru', cacheWith('corp.ru', false));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // проба 2 к тому же домену: рабочий IP-B пробуется ПЕРВЫМ → 1 вызов,
    // без 8с-ожидания на слепом IP-A (это и есть устранённая латентность)
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    const res = await validateEmail('user2@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1); // не потратили попытку на слепой IP-A
    expect(String(fetchMock.mock.calls[0][0])).toContain('proxy-b'); // пошли сразу на рабочий IP
  });

  it('greylist-affinity: повтор к тому же MX идёт на IP, который greylist-нул (round-robin не рассеивает)', async () => {
    // проба 1: первый IP (proxy-a) отдаёт greylist → affinity=proxy-a
    fetchMock.mockResolvedValueOnce(reply({ code: 451, exists: null, isCatchAll: null, greylist: true }));
    const r1 = await validateEmail('u1@corp.ru', cacheWith('corp.ru', false));
    expect(r1.result).toBe('unknown');
    expect(r1.details.step).toBe('greylist');
    expect(String(fetchMock.mock.calls[0][0])).toContain('proxy-a');

    // проба 2 (отложенный ретрай): без affinity round-robin пошёл бы на proxy-b,
    // но affinity пинит proxy-a первым → greylist на нём снят → ok, 1 вызов
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    const r2 = await validateEmail('u1@corp.ru', cacheWith('corp.ru', false));
    expect(r2.result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('proxy-a'); // тот же IP, что greylist-нул
  });

  it('слепой IP всё равно пробуется ПОСЛЕДНИМ, если рабочий тоже отказал (покрытие не теряется)', async () => {
    // обучаемся: IP-A слеп к mx.corp.ru
    fetchMock
      .mockResolvedValueOnce(reply({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ETIMEDOUT' }))
      .mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    await validateEmail('user1@corp.ru', cacheWith('corp.ru', false));

    // теперь IP-B (рабочий) отдаёт транспортный сбой, а IP-A (слепой, последний) — реальный ответ:
    // порядок [B, A], B inconclusive → failover на A → A подтверждает ящик. Оба IP использованы.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(reply({ code: 0, exists: null, isCatchAll: null, greylist: false, error: 'connect ETIMEDOUT' }))
      .mockResolvedValueOnce(reply({ code: 250, exists: true, isCatchAll: false, greylist: false }));
    const res = await validateEmail('user2@corp.ru', cacheWith('corp.ru', false));
    expect(res.result).toBe('ok'); // слепой IP всё же дал ответ — покрытие сохранено
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('proxy-b'); // рабочий первым
    expect(String(fetchMock.mock.calls[1][0])).toContain('proxy-a'); // слепой последним
  });
});
