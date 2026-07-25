/** @jest-environment node */
/**
 * Воркер email-валидации: таксономия ретраев, задержки retry_after и
 * dirty-фильтр доменного кэша. Оффлайн-тест чистых функций — БД не трогаем,
 * supabaseAdmin/logger/tracer замоканы.
 */

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('@/lib/loggerServer', () => ({ logError: jest.fn(), logInfo: jest.fn() }));
jest.mock('@/lib/tracer', () => ({ startTrace: jest.fn() }));

import {
  shouldRetry,
  classifyRetry,
  retryDelayMs,
  parseGreylistHintMs,
  filterDirtyCacheEntries,
  domainInfoSignature,
  MAX_ATTEMPTS,
} from '@/lib/emailValidation/emailValidationWorker';
import type { DomainInfo } from '@/lib/emailValidation/shared';

const GREYLIST_ERR = 'Сервер ответил временным отказом (greylisting)';
const GREYLIST_DETAILS = {
  step: 'greylist',
  smtp_code: 450,
  smtp_text: '450 4.7.1 Greylisted, try again in 900 seconds',
};

describe('classifyRetry: маппинг details.step → класс ретрая', () => {
  it('step=greylist → отложенный greylist-ретрай', () => {
    expect(classifyRetry(GREYLIST_ERR, GREYLIST_DETAILS, 1)).toBe('greylist');
    expect(shouldRetry(GREYLIST_ERR, 1, GREYLIST_DETAILS)).toBe(true);
  });

  it('step=over_quota → терминально, без ретрая даже при запасе попыток', () => {
    expect(classifyRetry('Превышена квота проверок', { step: 'over_quota' }, 1)).toBeNull();
    expect(shouldRetry('Превышена квота проверок', 1, { step: 'over_quota' })).toBe(false);
  });

  it('step=smtp_5xx_policy → терминально СРАЗУ (анти-проба постоянна, не держим джоб)', () => {
    const err = 'Сервер отклонил по политике/лимиту (554)';
    const details = { step: 'smtp_5xx_policy', smtp_text: '554 Transaction failed, spam policy' };
    // Продовая выборка: Backscatter/relay-denied/sender-rep не снимаются задержкой —
    // отложенный ретрай не конвертирует, но держит джоб заложником хвоста.
    expect(classifyRetry(err, details, 1)).toBeNull();
    expect(shouldRetry(err, 1, details)).toBe(false);
  });

  it('step=mx с DNS-ошибкой → dns-ретрай', () => {
    const err = 'DNS lookup failed (MX undetermined)';
    expect(classifyRetry(err, { step: 'mx', error: err }, 1)).toBe('dns');
  });

  it('step=mx «Нет MX-записей» → терминально (это invalid, не ретрай)', () => {
    expect(classifyRetry(undefined, { step: 'mx', error: 'Нет MX-записей для домена' }, 1)).toBeNull();
  });

  it('step=smtp (connect failures) → transport-ретрай', () => {
    const err = 'Не удалось подключиться ни к одному MX-серверу';
    expect(classifyRetry(err, { step: 'smtp', error: err }, 1)).toBe('transport');
  });

  it('step=catch_all_undetermined → transport-ретрай', () => {
    const err = 'Catch-all статус домена не определён (временный сбой проверки)';
    expect(classifyRetry(err, { step: 'catch_all_undetermined' }, 1)).toBe('transport');
  });

  it('proxy-ошибки → короткий proxy-ретрай независимо от шага', () => {
    expect(classifyRetry('Proxy http://10.0.0.1:3100: HTTP 502', { step: 'unknown' }, 1)).toBe('proxy');
    expect(classifyRetry('All SMTP proxies failed', { step: 'unknown' }, 1)).toBe('proxy');
    expect(classifyRetry('fetch failed', undefined, 1)).toBe('proxy');
    expect(classifyRetry('This operation was aborted', undefined, 1)).toBe('proxy');
  });
});

describe('classifyRetry: фолбэк по тексту для строк без details', () => {
  it('greylist-маркеры → greylist', () => {
    expect(classifyRetry('Server greylisted us', undefined, 1)).toBe('greylist');
    expect(classifyRetry('Временный сбой проверки', undefined, 1)).toBe('greylist');
    expect(classifyRetry('450 4.7.1 Greylisted, try again in 900 seconds', undefined, 1)).toBe('greylist');
    expect(classifyRetry('451 Temporary local problem', undefined, 1)).toBe('greylist');
  });

  it('dns/transport маркеры → соответствующие классы', () => {
    expect(classifyRetry('dns lookup failed (MX undetermined)', undefined, 1)).toBe('dns');
    expect(classifyRetry('connect ETIMEDOUT 1.2.3.4:25', undefined, 1)).toBe('transport');
    expect(classifyRetry('connect ECONNREFUSED', undefined, 1)).toBe('transport');
  });

  it('нераспознанная/пустая ошибка → терминально', () => {
    expect(classifyRetry('Превышено число попыток (3)', undefined, 1)).toBeNull();
    expect(classifyRetry(undefined, undefined, 1)).toBeNull();
  });
});

describe('classifyRetry: граница MAX_ATTEMPTS', () => {
  it('на пределе попыток любой ретрай запрещён', () => {
    expect(classifyRetry(GREYLIST_ERR, GREYLIST_DETAILS, MAX_ATTEMPTS)).toBeNull();
    expect(shouldRetry(GREYLIST_ERR, MAX_ATTEMPTS, GREYLIST_DETAILS)).toBe(false);
    expect(classifyRetry('fetch failed', undefined, MAX_ATTEMPTS)).toBeNull();
  });

  it('за шаг до предела ретрай ещё разрешён', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(classifyRetry(GREYLIST_ERR, GREYLIST_DETAILS, MAX_ATTEMPTS - 1)).toBe('greylist');
    expect(shouldRetry(GREYLIST_ERR, MAX_ATTEMPTS - 1, GREYLIST_DETAILS)).toBe(true);
  });
});

describe('parseGreylistHintMs: подсказка «try again in N» из smtp_text', () => {
  it('секунды и минуты', () => {
    expect(parseGreylistHintMs('450 4.7.1 Greylisted, try again in 900 seconds')).toBe(900_000);
    expect(parseGreylistHintMs('450 4.7.1 Try again in 15 minutes')).toBe(900_000);
  });

  it('нет подсказки → null', () => {
    expect(parseGreylistHintMs('450 4.7.1 Greylisted')).toBeNull();
    expect(parseGreylistHintMs(undefined)).toBeNull();
  });
});

// Диапазон с учётом ±10% джиттера.
const MIN = 60_000;
function expectDelay(actual: number, baseMs: number) {
  expect(actual).toBeGreaterThanOrEqual(Math.floor(baseMs * 0.9));
  expect(actual).toBeLessThanOrEqual(Math.ceil(baseMs * 1.1));
}

describe('retryDelayMs: задержки по классам с эскалацией', () => {
  it('greylist: «try again in 900 seconds» → ~15 минут (в пределах клэмпа)', () => {
    expectDelay(retryDelayMs('greylist', 1, GREYLIST_DETAILS.smtp_text), 15 * MIN);
  });

  it('greylist: подсказка 30 секунд клэмпится снизу до 1 минуты', () => {
    expectDelay(retryDelayMs('greylist', 1, '450 4.7.1 Greylisted, try again in 30 seconds'), 1 * MIN);
  });

  it('greylist: подсказка 120 минут клэмпится сверху до 20 минут (под кэп хвоста)', () => {
    // Верхний клэмп 20 мин × джиттер 1.1 = 22 мин < TAIL_CAP (25 мин дефолт) —
    // hinted-ретрай должен успеть сработать до таймаута хвоста джоба.
    expectDelay(retryDelayMs('greylist', 1, '450 4.7.1 try again in 120 minutes'), 20 * MIN);
  });

  it('greylist без подсказки: расписание 5→15→30 минут по попыткам', () => {
    expectDelay(retryDelayMs('greylist', 1), 5 * MIN);
    expectDelay(retryDelayMs('greylist', 2), 15 * MIN);
    expectDelay(retryDelayMs('greylist', 3), 30 * MIN);
    expectDelay(retryDelayMs('greylist', 99), 30 * MIN); // за пределами — последнее
  });

  it('dns: 5→15 минут', () => {
    expectDelay(retryDelayMs('dns', 1), 5 * MIN);
    expectDelay(retryDelayMs('dns', 2), 15 * MIN);
    expectDelay(retryDelayMs('dns', 9), 15 * MIN);
  });

  it('transport: 2→10 минут', () => {
    expectDelay(retryDelayMs('transport', 1), 2 * MIN);
    expectDelay(retryDelayMs('transport', 2), 10 * MIN);
    expectDelay(retryDelayMs('transport', 9), 10 * MIN);
  });

  it('proxy: 1→5 минут', () => {
    expectDelay(retryDelayMs('proxy', 1), 1 * MIN);
    expectDelay(retryDelayMs('proxy', 2), 5 * MIN);
    expectDelay(retryDelayMs('proxy', 9), 5 * MIN);
  });
});

function domainInfo(domain: string, over: Partial<DomainInfo> = {}): DomainInfo {
  return {
    domain,
    mxHosts: [`mx.${domain}`],
    mxFound: true,
    isCatchAll: null,
    isDisposable: false,
    checkedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

describe('filterDirtyCacheEntries: dirty-set доменного кэша (фикс TTL laundering)', () => {
  it('нетронутая запись не апсертится, новая и изменённая — апсертятся', () => {
    const untouched = domainInfo('untouched.ru');
    const mutatedLoaded = domainInfo('mutated.ru');
    const snapshot = new Map([
      ['untouched.ru', domainInfoSignature(untouched)],
      ['mutated.ru', domainInfoSignature(mutatedLoaded)],
    ]);

    // validateEmail мутирует isCatchAll in-place (validator.ts), checkedAt не меняется
    mutatedLoaded.isCatchAll = true;
    const fresh = domainInfo('fresh.ru', { checkedAt: new Date('2026-07-24T00:00:00Z') });

    const cache = new Map([
      ['untouched.ru', untouched],
      ['mutated.ru', mutatedLoaded],
      ['fresh.ru', fresh],
    ]);

    const dirty = filterDirtyCacheEntries(cache, snapshot).map((d) => d.domain);
    expect(dirty).toEqual(['mutated.ru', 'fresh.ru']);
  });

  it('разница только в checkedAt записью не «пачкается»', () => {
    const loaded = domainInfo('old.ru', { checkedAt: new Date('2026-01-01T00:00:00Z') });
    const snapshot = new Map([['old.ru', domainInfoSignature(loaded)]]);
    loaded.checkedAt = new Date('2026-07-24T00:00:00Z');
    expect(filterDirtyCacheEntries(new Map([['old.ru', loaded]]), snapshot)).toEqual([]);
  });

  it('мутация mxFound/mxHosts тоже считается изменением', () => {
    const d = domainInfo('nomx.ru');
    const snapshot = new Map([['nomx.ru', domainInfoSignature(d)]]);
    d.mxFound = false;
    d.mxHosts = [];
    expect(filterDirtyCacheEntries(new Map([['nomx.ru', d]]), snapshot)).toHaveLength(1);
  });

  it('пустой dirty-set → пустой результат (saveDomainCache не дёргает БД)', () => {
    const a = domainInfo('a.ru');
    const b = domainInfo('b.ru', { isCatchAll: false });
    const snapshot = new Map([
      ['a.ru', domainInfoSignature(a)],
      ['b.ru', domainInfoSignature(b)],
    ]);
    expect(filterDirtyCacheEntries(new Map([['a.ru', a], ['b.ru', b]]), snapshot)).toEqual([]);
  });
});
