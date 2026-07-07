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

  it('мёртвый role-ящик spf@/dkim@/dmarc@ (эхо адреса) остаётся invalid, не unknown', () => {
    // Сервер эхом возвращает адрес; токен в localpart НЕ должен спутать с SPF-отказом
    expect(classifyRcpt5xx('550 5.1.1 <spf@acme.com>: Recipient address rejected: User unknown')).toBe('invalid');
    expect(classifyRcpt5xx('550 5.1.1 <dkim@acme.com>: No such user')).toBe('invalid');
    expect(classifyRcpt5xx('550 5.1.1 <dmarc-reports@acme.com>: User unknown')).toBe('invalid');
    // look-alike ДОМЕН тоже не должен ловиться
    expect(classifyRcpt5xx('550 5.1.1 <bob@dmarc.io>: No such user')).toBe('invalid');
  });

  it('настоящий SPF/backscatter отказ (вне <скобок>) по-прежнему → unknown', () => {
    expect(classifyRcpt5xx('550 5.7.23 <a@b.ru>: SPF check failed')).toBe('unknown');
    expect(classifyRcpt5xx('550 5.1.1 <a@b.ru> Backscatter Protection detected an invalid or unauthenticated address')).toBe('unknown');
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
