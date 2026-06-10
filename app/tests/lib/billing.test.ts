/** @jest-environment node */

/**
 * Unit-level coverage for the pure parts of lib/billing.ts:
 *   - mapYookassaErrorRu: deterministic table mapping.
 *   - __internal.resolveBillingAmount: precedence of stored billing_amount
 *     over the type+period calculator, with custom-tariff edge case.
 *   - __internal.isPendingInvoiceStillValid: 30-day TTL window relative to
 *     the invoice row's created_at vs supplied "now".
 *   - __internal.buildDescription: russian copy with verb varying by reason.
 *
 * The orchestrator paths (ensurePendingInvoiceForTariff, chargeMonthlyRenewal)
 * exercise supabase + yookassa fetch and are intentionally out of scope here —
 * they're covered by integration tests / manual QA against the staging YK
 * shop. Keeping these unit tests focused on pure logic keeps the suite fast
 * and free of stubs that drift from real supabase-js shape.
 */

import { mapYookassaErrorRu, __internal } from '@/lib/billing';

describe('mapYookassaErrorRu', () => {
  it.each([
    ['insufficient_funds',         'Недостаточно средств на карте.'],
    ['expired_card',               'Срок действия карты истёк.'],
    ['card_expired',               'Срок действия карты истёк.'],
    ['issuer_unavailable',         'Банк отклонил платёж. Свяжитесь с банком.'],
    ['call_issuer',                'Банк отклонил платёж. Свяжитесь с банком.'],
    ['3d_secure_failed',           'Не прошла проверка 3-D Secure.'],
    ['payment_method_restricted',  'Платёж отклонён банком.'],
    ['general_decline',            'Платёж отклонён банком.'],
    ['fraud_suspected',            'Платёж заблокирован системой безопасности.'],
    ['country_forbidden',          'Платежи из вашей страны запрещены.'],
    ['payment_method_limit_exceeded', 'Превышен лимит платежей по карте.'],
  ])('maps %s', (reason, expected) => {
    expect(mapYookassaErrorRu(reason)).toBe(expected);
  });

  it('returns a generic ru fallback for unknown reasons', () => {
    expect(mapYookassaErrorRu('something_new_yk_added')).toBe(
      'Не удалось списать. Попробуйте снова или другой картой.',
    );
  });

  it('treats null / undefined / empty string as unknown', () => {
    const fallback = 'Не удалось списать. Попробуйте снова или другой картой.';
    expect(mapYookassaErrorRu(null)).toBe(fallback);
    expect(mapYookassaErrorRu(undefined)).toBe(fallback);
    expect(mapYookassaErrorRu('')).toBe(fallback);
  });

  it('surfaces the "permission revoked" advice text', () => {
    // Distinct from the generic fallback — special-cased because the actionable
    // next step (re-link a card via «Оплатить подписку») differs from "try again".
    expect(mapYookassaErrorRu('permission_revoked')).toMatch(/привяжите карту заново/i);
  });
});

describe('__internal.resolveBillingAmount', () => {
  const base = {
    tariff_type: 'standard' as const,
    billing_period: 'month' as const,
    billing_amount: null as number | null,
  };

  it('prefers stored billing_amount when positive', () => {
    expect(__internal.resolveBillingAmount({ ...base, billing_amount: 480_000 })).toBe(480_000);
  });

  it('ignores stored billing_amount=0 and falls back to calc', () => {
    // billing_amount=0 is technically a "set" value but cannot represent a real
    // charge — treat as unset so we don't accidentally try to charge ₽0.
    const amount = __internal.resolveBillingAmount({ ...base, billing_amount: 0 });
    expect(amount).toBe(__internal.TARIFF_MONTHLY_PRICE.standard * __internal.BILLING_PERIOD_MONTHS.month);
  });

  it('falls back to monthly price when billing_period is null', () => {
    expect(__internal.resolveBillingAmount({ ...base, billing_period: null })).toBe(
      __internal.TARIFF_MONTHLY_PRICE.standard,
    );
  });

  it('multiplies by period months for half_year', () => {
    expect(__internal.resolveBillingAmount({ ...base, billing_period: 'half_year' })).toBe(
      __internal.TARIFF_MONTHLY_PRICE.standard * 6,
    );
  });

  it('multiplies by period months for year on pro', () => {
    expect(
      __internal.resolveBillingAmount({ ...base, tariff_type: 'pro', billing_period: 'year' }),
    ).toBe(__internal.TARIFF_MONTHLY_PRICE.pro * 12);
  });

  it('returns null for custom tariff without explicit billing_amount', () => {
    // Custom tariffs have no default price — admin must set the amount.
    // Caller is expected to treat null as "ask admin", not as ₽0.
    expect(
      __internal.resolveBillingAmount({ ...base, tariff_type: 'custom', billing_amount: null }),
    ).toBeNull();
  });
});

describe('__internal.isPendingInvoiceStillValid', () => {
  // YK invoices live ~30 days (the YK API enforces it); we use ms-based
  // comparison against created_at because we don't separately persist
  // expires_at on our row.
  const now = new Date('2026-06-09T12:00:00Z');

  it('reuses an invoice created today', () => {
    expect(
      __internal.isPendingInvoiceStillValid(
        { created_at: '2026-06-09T11:00:00Z', yookassa_payment_url: 'https://yookassa.ru/i/abc' },
        now,
      ),
    ).toBe(true);
  });

  it('reuses an invoice created 29 days ago', () => {
    expect(
      __internal.isPendingInvoiceStillValid(
        { created_at: '2026-05-11T12:00:00Z', yookassa_payment_url: 'https://yookassa.ru/i/abc' },
        now,
      ),
    ).toBe(true);
  });

  it('does not reuse an invoice created 31 days ago', () => {
    expect(
      __internal.isPendingInvoiceStillValid(
        { created_at: '2026-05-09T11:00:00Z', yookassa_payment_url: 'https://yookassa.ru/i/abc' },
        now,
      ),
    ).toBe(false);
  });

  it('does not reuse when yookassa_payment_url is missing', () => {
    // Invoice insert succeeded but YK call failed — caller should retry the
    // YK side; this means we must NOT short-circuit and "reuse" the URL-less
    // row, otherwise the caller would return null URL to the client forever.
    expect(
      __internal.isPendingInvoiceStillValid(
        { created_at: now.toISOString(), yookassa_payment_url: null },
        now,
      ),
    ).toBe(false);
  });

  it('rejects an invoice whose created_at is unparseable', () => {
    expect(
      __internal.isPendingInvoiceStillValid(
        { created_at: 'not-a-date', yookassa_payment_url: 'https://yookassa.ru/i/abc' },
        now,
      ),
    ).toBe(false);
  });
});

describe('__internal.buildDescription', () => {
  // Universal description "Подписка на Portal" replaced the old per-reason
  // / per-tariff string. The tests below pin that contract: tariff, period,
  // company name and reason are all intentionally ignored — the only thing
  // that matters is that what the customer sees on the YooKassa form is
  // stable, short, and brand-consistent.
  it('returns "Подписка на Portal" regardless of inputs', () => {
    expect(__internal.buildDescription('standard', 'month', 'ООО Ромашка', 'admin_activate')).toBe(
      'Подписка на Portal',
    );
    expect(__internal.buildDescription('pro', 'year', 'Acme', 'client_self')).toBe(
      'Подписка на Portal',
    );
    expect(__internal.buildDescription('custom', 'half_year', 'Anything', 'cron_renew')).toBe(
      'Подписка на Portal',
    );
    expect(__internal.buildDescription('standard', null, '', 'admin_extend')).toBe(
      'Подписка на Portal',
    );
  });
});

describe('__internal.pickReceiptEmail', () => {
  const ORIG_FALLBACK = process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL;
  afterEach(() => {
    if (ORIG_FALLBACK === undefined) delete process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL;
    else process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL = ORIG_FALLBACK;
  });

  it('prefers profile email over fallback env', () => {
    process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL = 'fallback@example.com';
    expect(__internal.pickReceiptEmail({ email: 'client@example.com' })).toBe('client@example.com');
  });

  it('uses YOOKASSA_FALLBACK_RECEIPT_EMAIL when no profile email', () => {
    process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL = 'fallback@example.com';
    expect(__internal.pickReceiptEmail(null)).toBe('fallback@example.com');
    expect(__internal.pickReceiptEmail({ email: null })).toBe('fallback@example.com');
    expect(__internal.pickReceiptEmail({ email: '   ' })).toBe('fallback@example.com');
  });

  it('returns null when both sources are absent', () => {
    delete process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL;
    expect(__internal.pickReceiptEmail(null)).toBeNull();
    expect(__internal.pickReceiptEmail({ email: '' })).toBeNull();
  });
});
