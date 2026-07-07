/** @jest-environment node */
/**
 * classifyRcpt5xx: анти-пробные 550 (сервер отверг НАШУ пробу, не ящик) →
 * 'unknown', а не 'invalid'. Тексты взяты из реальной базы (фарм/медицина,
 * leads (10), 05.07): backscatter-серверы 550-ят и настоящие открытые ящики.
 */

import { classifyRcpt5xx } from '@/lib/emailValidation/validator';

describe('classifyRcpt5xx: анти-пробные отказы → unknown, не invalid', () => {
  it('Backscatter Protection (реальный текст ozon-pharm.ru) → unknown', () => {
    expect(classifyRcpt5xx('550 5.1.1 Backscatter Protection detected an invalid or unauthenticated address')).toBe('unknown');
  });

  it('sender verify / callout → unknown', () => {
    expect(classifyRcpt5xx('550 Sender verify failed')).toBe('unknown');
    expect(classifyRcpt5xx('550 5.1.0 Sender address rejected: sender callout verification failed')).toBe('unknown');
  });

  it('SPF/DKIM/DMARC/auth отказы → unknown', () => {
    expect(classifyRcpt5xx('550 5.7.23 SPF check failed')).toBe('unknown');
    expect(classifyRcpt5xx('550 not authenticated')).toBe('unknown');
    expect(classifyRcpt5xx('550 5.7.1 Relaying denied')).toBe('unknown');
  });
});

describe('classifyRcpt5xx: настоящий user-unknown остаётся invalid', () => {
  it('явный "no such user" → invalid', () => {
    expect(classifyRcpt5xx('550 5.1.1 <a@b.ru>: No such user')).toBe('invalid');
    expect(classifyRcpt5xx('550 5.1.1 Recipient address rejected: User unknown')).toBe('invalid');
    expect(classifyRcpt5xx('550 нет такого пользователя')).toBe('invalid');
  });

  it('policy/rate 5xx → unknown (как было)', () => {
    expect(classifyRcpt5xx('554 Transaction failed, spam policy')).toBe('unknown');
    expect(classifyRcpt5xx('550 5.7.1 message blocked')).toBe('unknown');
  });

  it('пустой текст → invalid (совместимость со старым поведением)', () => {
    expect(classifyRcpt5xx('')).toBe('invalid');
    expect(classifyRcpt5xx(undefined)).toBe('invalid');
  });
});
