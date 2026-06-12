/** @jest-environment node */

import { getDefaultYookassaInvoiceExpiresAt, isYookassaConfigured } from '@/lib/yookassa';

describe('YooKassa invoice expiration', () => {
  it('keeps the default validity near 30 days with a safety buffer for YooKassa validation', () => {
    const now = new Date('2026-05-20T10:15:42.987Z');

    expect(getDefaultYookassaInvoiceExpiresAt(now)).toBe('2026-06-19T10:00:00.000Z');
  });
});

describe('isYookassaConfigured', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clone so each test mutates an isolated copy; restore in afterEach.
    process.env = { ...originalEnv };
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete process.env.YOOKASSA_TEST_SHOP_ID;
    delete process.env.YOOKASSA_TEST_SECRET_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true for the production shop when both live env vars are set', () => {
    process.env.YOOKASSA_SHOP_ID = 'live-shop';
    process.env.YOOKASSA_SECRET_KEY = 'live-secret';
    expect(isYookassaConfigured()).toBe(true);
    expect(isYookassaConfigured(false)).toBe(true);
  });

  it('returns false for the production shop when either env var is missing', () => {
    process.env.YOOKASSA_SHOP_ID = 'live-shop';
    expect(isYookassaConfigured(false)).toBe(false);
  });

  it('returns true for the test shop when both test env vars are set', () => {
    process.env.YOOKASSA_TEST_SHOP_ID = 'test-shop';
    process.env.YOOKASSA_TEST_SECRET_KEY = 'test-secret';
    expect(isYookassaConfigured(true)).toBe(true);
  });

  it('returns false for the test shop when only live env vars are set', () => {
    process.env.YOOKASSA_SHOP_ID = 'live-shop';
    process.env.YOOKASSA_SECRET_KEY = 'live-secret';
    expect(isYookassaConfigured(true)).toBe(false);
  });
});
