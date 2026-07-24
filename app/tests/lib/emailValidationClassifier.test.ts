/** @jest-environment node */
/**
 * Пины новых правил классификатора и смежных веток validateEmail (аудит
 * качества email-валидации, 2026-07):
 *  - Exchange policy "Recipient address rejected: Access denied" → unknown;
 *  - sender-reputation отказы ("bad outbound sender", "Sender rejected") → unknown;
 *  - русскоязычный rate-limit/политика → unknown;
 *  - 452/«mailbox full»/«over quota» → unknown со step 'over_quota' (терминальный,
 *    БЕЗ «временн» в тексте ошибки — воркер не должен ретраить);
 *  - «голое» эхо адреса без <скобок> не маскирует настоящий user-unknown;
 *  - freemail-доверие: кураторский FREE_PROVIDERS + catch-all не определён → ok,
 *    typo-squat вне FREE_PROVIDERS (maail.ru) → по-прежнему unknown;
 *  - продолжение по следующему MX при exists=true + isCatchAll=null;
 *  - IDN-домен (почта.рф) идёт в проверку по punycode-форме, а не падает на syntax.
 *
 * SMTP-проба мокается через global.fetch, DNS не трогаем (domainCache
 * предзаполнен). Env/fetch ставятся ДО динамического импорта валидатора.
 */

import { isFreeProvider, type DomainInfo, type ValidationResult } from '@/lib/emailValidation/shared';

type SmtpPayload = {
  code: number;
  exists: boolean | null;
  isCatchAll: boolean | null;
  greylist: boolean;
  smtpText?: string;
  error?: string;
};

let validateEmail: (email: string, cache: Map<string, DomainInfo>) => Promise<ValidationResult>;
let classifyRcpt5xx: (text: string | undefined, probedEmail?: string) => 'invalid' | 'unknown';

const fetchMock = jest.fn();

beforeAll(async () => {
  process.env.SMTP_PROXY_URLS = 'http://smtp-proxy.test:3100';
  delete process.env.SMTP_PROXY_URL;
  global.fetch = fetchMock as unknown as typeof fetch;
  const mod = await import('@/lib/emailValidation/validator');
  validateEmail = mod.validateEmail;
  classifyRcpt5xx = mod.classifyRcpt5xx;
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

describe('classifyRcpt5xx: policy-flavored «recipient rejected» → unknown', () => {
  it('Exchange Online "Recipient address rejected: Access denied" → unknown', () => {
    expect(classifyRcpt5xx('550 5.4.1 Recipient address rejected: Access denied')).toBe('unknown');
  });

  it('те же формулировки БЕЗ policy-слов → invalid (настоящий user-unknown)', () => {
    expect(classifyRcpt5xx('550 5.4.1 Recipient address rejected: User unknown')).toBe('invalid');
    expect(classifyRcpt5xx('550 mailbox unavailable')).toBe('invalid');
    expect(classifyRcpt5xx('550 recipient rejected')).toBe('invalid');
  });

  it('Yandex "550 5.7.1 No such user!" остаётся invalid', () => {
    expect(classifyRcpt5xx('550 5.7.1 No such user! 1782325033-abc')).toBe('invalid');
  });
});

describe('classifyRcpt5xx: sender-reputation отказы → unknown', () => {
  it('"bad outbound sender" (Exchange AS(4201)) → unknown', () => {
    expect(classifyRcpt5xx('550 5.1.8 Access denied, bad outbound sender AS(4201)')).toBe('unknown');
  });

  it('"Sender rejected" (5.1.0) → unknown, а не invalid по голому 5.1.x', () => {
    expect(classifyRcpt5xx('550 5.1.0 Sender rejected')).toBe('unknown');
  });
});

describe('classifyRcpt5xx: русскоязычные policy/rate-limit → unknown', () => {
  it('"Слишком много соединений" → unknown', () => {
    expect(classifyRcpt5xx('550 Слишком много соединений с вашего IP')).toBe('unknown');
  });

  it('прочие русские policy-токены → unknown', () => {
    expect(classifyRcpt5xx('550 Превышен лимит подключений, повторите позже')).toBe('unknown');
    expect(classifyRcpt5xx('554 Письмо отклонено как спам')).toBe('unknown');
    expect(classifyRcpt5xx('550 Отправитель в чёрном списке, заблокирован')).toBe('unknown');
  });

  it('русский user-unknown остаётся invalid', () => {
    expect(classifyRcpt5xx('550 нет такого пользователя')).toBe('invalid');
    expect(classifyRcpt5xx('550 Пользователь не существует')).toBe('invalid');
  });
});

describe('classifyRcpt5xx: квота/переполнение → unknown (ящик жив)', () => {
  it('mailbox full / over quota → unknown', () => {
    expect(classifyRcpt5xx('552 5.2.2 Mailbox full')).toBe('unknown');
    expect(classifyRcpt5xx('552 5.2.2 user is over quota')).toBe('unknown');
    expect(classifyRcpt5xx('552 5.2.2 Quota exceeded (mailbox for user is full)')).toBe('unknown');
    expect(classifyRcpt5xx('452 4.2.2 Insufficient storage')).toBe('unknown');
  });
});

describe('classifyRcpt5xx: «голое» эхо адреса (без <скобок>)', () => {
  it('эхо spf@acme.com вырезается → настоящий user-unknown остаётся invalid', () => {
    expect(classifyRcpt5xx('550 5.1.1 spf@acme.com: User unknown', 'spf@acme.com')).toBe('invalid');
  });

  it('эхо look-alike домена вырезается → invalid', () => {
    expect(classifyRcpt5xx('550 5.1.1 bob@dmarc.io: No such user', 'bob@dmarc.io')).toBe('invalid');
  });

  it('настоящая анти-проба (вне эха) → unknown', () => {
    expect(classifyRcpt5xx('550 5.1.1 Backscatter Protection detected', 'spf@acme.com')).toBe('unknown');
  });
});

describe('FREE_PROVIDERS: кураторский freemail-список', () => {
  it('rambler.ru и базовые провайдеры на месте', () => {
    expect(isFreeProvider('rambler.ru')).toBe(true);
    expect(isFreeProvider('mail.ru')).toBe(true);
    expect(isFreeProvider('gmail.com')).toBe(true);
  });

  it('новые провайдеры добавлены', () => {
    for (const d of ['pochta.ru', 'ngs.ru', 'e1.ru', 'mail15.com', 'yandex.kz', 'yandex.uz', 'yandex.com.tr']) {
      expect(isFreeProvider(d)).toBe(true);
    }
  });

  it('typo-squat домены (maail.ru, eandex.ru) НЕ входят в freemail', () => {
    expect(isFreeProvider('maail.ru')).toBe(false);
    expect(isFreeProvider('eandex.ru')).toBe(false);
  });
});

describe('validateEmail: freemail-доверие при неопределённом catch-all', () => {
  it('freemail (mail.ru) + exists=true + isCatchAll=null → ok', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: null, greylist: false });
    const res = await validateEmail('user@mail.ru', cacheWith('mail.ru', null));
    expect(res.result).toBe('ok');
    expect(res.quality).toBe('good');
    expect(res.is_free).toBe(true);
    expect(res.details.step).toBe('smtp_ok');
  });

  it('typo-squat maail.ru (НЕ freemail) + exists=true + isCatchAll=null → по-прежнему unknown', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: null, greylist: false });
    const res = await validateEmail('lekmed@maail.ru', cacheWith('maail.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('catch_all_undetermined');
    expect(res.error).toMatch(/временн/i); // ретраябельный unknown, не ok
  });

  it('не-freemail корп. домен + exists=true + isCatchAll=null → unknown (как раньше)', async () => {
    smtpReply({ code: 250, exists: true, isCatchAll: null, greylist: false });
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('catch_all_undetermined');
  });
});

describe('validateEmail: квота → терминальный unknown со step over_quota', () => {
  it('452 + exists=null → unknown, step over_quota, БЕЗ «временн» (воркер не ретраит)', async () => {
    smtpReply({ code: 452, exists: null, isCatchAll: null, greylist: false, smtpText: '452 4.2.2 Mailbox full' });
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.quality).toBe('risky');
    expect(res.details.step).toBe('over_quota');
    expect(res.error).not.toMatch(/временн|greylist|450|451/i);
  });

  it('не-452 код, но текст про квоту (exists=null) → тоже over_quota', async () => {
    smtpReply({ code: 552, exists: null, isCatchAll: null, greylist: false, smtpText: '552 5.2.2 Over quota' });
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('over_quota');
    expect(res.error).not.toMatch(/временн|greylist/i);
  });

  it('greylist ветка теперь несёт details.smtp_text (контракт воркера)', async () => {
    smtpReply({ code: 451, exists: null, isCatchAll: null, greylist: true, smtpText: '451 4.7.1 Greylisting in action' });
    const res = await validateEmail('user@corp.ru', cacheWith('corp.ru', null));
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('greylist');
    expect(res.details.smtp_text).toBe('451 4.7.1 Greylisting in action');
  });
});

describe('validateEmail: продолжение по MX при exists=true + isCatchAll=null', () => {
  it('MX1 подтвердил ящик без catch-all ответа → MX2 решает catch-all → ok', async () => {
    const cache = new Map<string, DomainInfo>([['corp.ru', {
      domain: 'corp.ru',
      mxHosts: ['mx1.corp.ru', 'mx2.corp.ru'],
      mxFound: true,
      isCatchAll: null,
      isDisposable: false,
      checkedAt: new Date(),
    }]]);
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { mxHost: string; checkCatchAll: boolean };
      // Обеим MX шлём checkCatchAll=true (статус ещё не определён)
      expect(body.checkCatchAll).toBe(true);
      if (body.mxHost === 'mx1.corp.ru') {
        return { ok: true, json: async () => ({ code: 250, exists: true, isCatchAll: null, greylist: false }) };
      }
      return { ok: true, json: async () => ({ code: 250, exists: true, isCatchAll: false, greylist: false }) };
    });
    const res = await validateEmail('user@corp.ru', cache);
    expect(res.result).toBe('ok'); // MX2 конклюзивно отверг random-пробу
    expect(fetchMock).toHaveBeenCalledTimes(2); // оба MX опрошены
    expect(cache.get('corp.ru')!.isCatchAll).toBe(false); // ответ MX2 закэширован
  });

  it('MX1 greylist → НЕ продолжаем на MX2 (greylist важнее)', async () => {
    const cache = new Map<string, DomainInfo>([['corp.ru', {
      domain: 'corp.ru',
      mxHosts: ['mx1.corp.ru', 'mx2.corp.ru'],
      mxFound: true,
      isCatchAll: null,
      isDisposable: false,
      checkedAt: new Date(),
    }]]);
    smtpReply({ code: 451, exists: null, isCatchAll: null, greylist: true });
    const res = await validateEmail('user@corp.ru', cache);
    expect(res.result).toBe('unknown');
    expect(res.details.step).toBe('greylist');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('validateEmail: IDN-домен (почта.рф)', () => {
  it('user@почта.рф проходит syntax и пробуется по punycode-форме домена', async () => {
    const puny = 'xn--80a1acny.xn--p1ai'; // почта.рф
    const cache = new Map<string, DomainInfo>([[puny, {
      domain: puny,
      mxHosts: [`mx.${puny}`],
      mxFound: true,
      isCatchAll: false,
      isDisposable: false,
      checkedAt: new Date(),
    }]]);
    smtpReply({ code: 250, exists: true, isCatchAll: false, greylist: false });
    const res = await validateEmail('user@почта.рф', cache);
    expect(res.details.step).not.toBe('syntax'); // раньше падало здесь
    expect(res.result).toBe('ok');
    // проба ушла на прокси в ASCII/punycode-форме
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as { email: string };
    expect(body.email).toBe(`user@${puny}`);
  });
});
