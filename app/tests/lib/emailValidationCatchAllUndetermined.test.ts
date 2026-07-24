/** @jest-environment node */
/**
 * validateEmail: неопределённый catch-all и typo-squat домены не должны
 * получать 'ok' (разбор баунсов Coldy 2026-07-02: typo-домены maail.ru,
 * eandex.ru и т.п. получали «Хороший» при isCatchAll=null и уходили в
 * рассылку).
 *
 * SMTP-проба мокается через global.fetch (smtpVerifyViaProxy), DNS не
 * трогаем: domainCache предзаполнен, так что lookupMX не вызывается.
 */

import type { DomainInfo, ValidationResult } from '@/lib/emailValidation/shared';

type SmtpPayload = {
  code: number;
  exists: boolean | null;
  isCatchAll: boolean | null;
  greylist: boolean;
  smtpText?: string;
};

let validateEmail: (email: string, cache: Map<string, DomainInfo>) => Promise<ValidationResult>;

const fetchMock = jest.fn();

beforeAll(async () => {
  // Явно задаём множественную форму и убираем одиночную: validator читает
  // SMTP_PROXY_URLS при загрузке модуля, а SMTP_PROXY_URL из окружения воркера
  // мог бы перетянуть конфиг на чужой прокси (изоляция как в
  // emailValidationProxyFailover.test.ts).
  process.env.SMTP_PROXY_URLS = 'http://smtp-proxy.test:3100';
  delete process.env.SMTP_PROXY_URL;
  global.fetch = fetchMock as unknown as typeof fetch;
  ({ validateEmail } = await import('@/lib/emailValidation/validator'));
});

beforeEach(() => {
  fetchMock.mockReset();
});

function smtpReply(payload: SmtpPayload) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload });
}

function cacheWith(domain: string, isCatchAll: boolean | null): Map<string, DomainInfo> {
  return new Map([[domain, {
    domain,
    mxHosts: [`mx.${domain}`],
    mxFound: true,
    isCatchAll,
    isDisposable: false,
    checkedAt: new Date(),
  }]]);
}

describe('validateEmail: неопределённый catch-all', () => {
  it('exists=true + isCatchAll=null → unknown/risky, не ok', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: null, greylist: false });
    const res = await validateEmail('user@alfa-medika.ru', cacheWith('alfa-medika.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.quality).toBe('risky');
    expect(res.details.step).toBe('catch_all_undetermined');
    // «временн» в тексте — воркер должен ретраить такой unknown
    expect(res.error).toMatch(/временн/i);
  });

  it('exists=true + isCatchAll=false (проба дала ответ) → ok', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: false, greylist: false });
    const res = await validateEmail('user@eastpole.ru', cacheWith('eastpole.ru', null));
    expect(res.result).toBe('ok');
    expect(res.quality).toBe('good');
  });

  it('exists=true + isCatchAll=false из кэша домена → ok без catch-all пробы', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: null, greylist: false });
    const res = await validateEmail('user@eastpole.ru', cacheWith('eastpole.ru', false));
    expect(res.result).toBe('ok');
  });

  it('exists=true + isCatchAll=true → catch_all (как раньше)', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: true, greylist: false });
    const res = await validateEmail('user@mail.ru', cacheWith('mail.ru', null));
    expect(res.result).toBe('catch_all');
    expect(res.quality).toBe('risky');
  });
});

describe('validateEmail: did_you_mean — информационная подсказка, не вердикт', () => {
  it('легитимный домен-близнец (isCatchAll=false, честный отказ random-пробе) остаётся ok', async () => {
    // aa.ru ~ ya.ru (levenshtein 1): домен конклюзивно отверг случайный адрес
    // и подтвердил конкретный ящик — понижать вердикт нельзя (vk.com, hh.ru,
    // yandex.by и т.п. — реальные домены в 1-2 правках от провайдеров).
    smtpReply({ code: 250, exists: true, isCatchAll: false, greylist: false });
    const res = await validateEmail('user@aa.ru', cacheWith('aa.ru', null));
    expect(res.result).toBe('ok');
    expect(res.quality).toBe('good');
    expect(res.did_you_mean).toBe('user@ya.ru');
  });

  it('typo-домен с неопределённым catch-all → catch_all_undetermined (реальный сценарий Coldy)', async () => {
    // maail.ru-ловушки принимают всё; их ловит ветка undetermined/catch_all,
    // а не сходство имени. did_you_mean сохраняется для ручного исправления.
    smtpReply({ code: 250, exists: true, isCatchAll: null, greylist: false });
    const res = await validateEmail('lekmed@maail.ru', cacheWith('maail.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('catch_all_undetermined');
    expect(res.did_you_mean).toBe('lekmed@mail.ru');
    expect(res.error).toMatch(/временн/i);
  });

  it('невалидный ящик на домене-опечатке остаётся invalid', async () => {
    smtpReply({ code: 550, exists: false, isCatchAll: null, greylist: false, smtpText: '550 5.1.1 No such user' });
    const res = await validateEmail('lekmed@maail.ru', cacheWith('maail.ru', null));
    expect(res.result).toBe('invalid');
  });
});

describe('validateEmail: прежние ветки не задеты', () => {
  it('greylist → unknown со step=greylist', async () => {
    smtpReply({ code: 451, exists: null, isCatchAll: null, greylist: true });
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('greylist');
  });

  it('5xx user-unknown → invalid', async () => {
    smtpReply({ code: 550, exists: false, isCatchAll: null, greylist: false, smtpText: '550 No such user here' });
    const res = await validateEmail('dead@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('invalid');
    expect(res.quality).toBe('bad');
  });

  it('5xx policy-block → unknown (classifyRcpt5xx)', async () => {
    smtpReply({ code: 554, exists: false, isCatchAll: null, greylist: false, smtpText: '554 Transaction failed, spam policy' });
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('smtp_5xx_policy');
  });
});
