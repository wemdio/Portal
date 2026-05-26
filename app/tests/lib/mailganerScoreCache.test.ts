import { describe, expect, test } from '@jest/globals';
import { normalizeDomain, emptyCacheStats } from '@/lib/jobs/mailganerScoreCache';

describe('normalizeDomain', () => {
  test('lowercases input', () => {
    expect(normalizeDomain('Stripe.COM')).toBe('stripe.com');
  });

  test('strips leading www.', () => {
    expect(normalizeDomain('www.ya.ru')).toBe('ya.ru');
    expect(normalizeDomain('WWW.YANDEX.RU')).toBe('yandex.ru');
  });

  test('trims whitespace', () => {
    expect(normalizeDomain('  stripe.com  ')).toBe('stripe.com');
  });

  test('returns null for empty/invalid', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
    expect(normalizeDomain('a')).toBeNull();        // too short
    expect(normalizeDomain('nodot')).toBeNull();    // no dot
  });

  test('non-www subdomain is kept (intentional — different deliverability)', () => {
    expect(normalizeDomain('mail.stripe.com')).toBe('mail.stripe.com');
    expect(normalizeDomain('shop.ya.ru')).toBe('shop.ya.ru');
  });
});

describe('emptyCacheStats', () => {
  test('all counters start at zero', () => {
    expect(emptyCacheStats()).toEqual({ hits: 0, misses: 0, errors: 0 });
  });
});
