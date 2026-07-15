import {
  calcBillingAmount,
  BILLING_PERIOD_MONTHS,
  BILLING_PERIOD_DISCOUNT,
  TEST_TARIFF_PRICE,
  TEST_PERIOD_MINUTES_BY_PERIOD,
  TEST_SETUP_MINUTES,
  getBillingPeriodStart,
  isClientToolAccessAllowed,
  isAwaitingFirstPayment,
} from '@/lib/tariffs';
import type { ClientTariffRow } from '@/lib/tariffs';

/** Минимальная строка тарифа для тестов getBillingPeriodStart. */
function row(patch: Partial<ClientTariffRow>): ClientTariffRow {
  return {
    id: 't', user_id: 'u', tariff_type: 'standard',
    max_contacts: null, max_rows: null, max_chains_per_month: null,
    max_domains: null, max_emails: null,
    paid_at: null, paid_until: null, setup_until: null,
    is_active: true, billing_mode: 'invoice', payment_locked: false,
    billing_period: null, billing_amount: null,
    ...patch,
  } as ClientTariffRow;
}

describe('getBillingPeriodStart — начало ТЕКУЩЕГО периода', () => {
  it('первый месяц: paid_until = setup_until + месяц → возвращает setup_until (no-op)', () => {
    const r = row({
      setup_until: '2026-06-18T00:00:00.000Z',
      paid_until: '2026-07-18T00:00:00.000Z',
      billing_period: 'month',
    });
    expect(getBillingPeriodStart(r).slice(0, 10)).toBe('2026-06-18');
  });

  it('ПОСЛЕ продления: setup_until заморожен, но старт едет вперёд на новый месяц', () => {
    // Месяц 2: paid_until = setup_until + 2 месяца, setup_until прежний.
    const r = row({
      setup_until: '2026-06-18T00:00:00.000Z',
      paid_until: '2026-08-18T00:00:00.000Z',
      billing_period: 'month',
    });
    // Старт текущего периода = 18.07, НЕ замороженный 18.06.
    expect(getBillingPeriodStart(r).slice(0, 10)).toBe('2026-07-18');
  });

  it('квартал: вычитается 3 месяца', () => {
    const r = row({
      setup_until: '2026-01-10T00:00:00.000Z',
      paid_until: '2026-04-10T00:00:00.000Z',
      billing_period: 'quarter',
    });
    expect(getBillingPeriodStart(r).slice(0, 10)).toBe('2026-01-10');
  });

  it('ручной режим (billing_period=null): fallback на прежнее setup_until', () => {
    const r = row({
      setup_until: '2026-05-01T00:00:00.000Z',
      paid_until: '2026-06-01T00:00:00.000Z',
      billing_period: null,
    });
    expect(getBillingPeriodStart(r).slice(0, 10)).toBe('2026-05-01');
  });

  it('тест-магазин: период в минутах (test_period_minutes) вычитается, а не месяц', () => {
    const r = row({
      setup_until: '2026-06-18T00:00:00.000Z',
      paid_until: '2026-06-18T00:15:00.000Z', // +15 минут
      billing_period: 'month',
      test_period_minutes: 15,
    });
    // 00:15 − 15 мин = 00:00 = setup_until (а не месяц назад).
    expect(getBillingPeriodStart(r)).toBe('2026-06-18T00:00:00.000Z');
  });

  it('страховка: если paid_until − период уходит РАНЬШЕ setup_until (дрейф) → клампится к setup_until', () => {
    const r = row({
      setup_until: '2026-06-18T00:00:00.000Z',
      paid_until: '2026-07-14T00:00:00.000Z', // дрейф: −месяц = 14.06 < setup 18.06
      billing_period: 'month',
    });
    expect(getBillingPeriodStart(r).slice(0, 10)).toBe('2026-06-18');
  });

  it('нет paid_until → прежнее поведение: setup_until, иначе paid_at', () => {
    expect(getBillingPeriodStart(row({ setup_until: '2026-06-18T00:00:00.000Z' })).slice(0, 10)).toBe('2026-06-18');
    expect(getBillingPeriodStart(row({ paid_at: '2026-06-14T00:00:00.000Z' })).slice(0, 10)).toBe('2026-06-14');
  });

  it('край месяца (setup 31-е): setMonth-overflow даёт дрейф начала ВПЕРЁД, но НЕ раньше setup_until', () => {
    // paid_until = setup_until + 1 мес через setMonth: Jan 31 → Mar 3 (overflow).
    const r = row({
      setup_until: '2026-01-31T00:00:00.000Z',
      paid_until: '2026-03-03T00:00:00.000Z',
      billing_period: 'month',
    });
    const start = new Date(getBillingPeriodStart(r)).getTime();
    // Безопасность: не раньше setup_until — окно расхода не съедет в прошлое,
    // лимит не заблокирует ошибочно.
    expect(start).toBeGreaterThanOrEqual(new Date('2026-01-31T00:00:00.000Z').getTime());
    // Известный benign-дрейф ≤3 дней вперёд (self-heal со 2-го периода).
    expect(start).toBeLessThanOrEqual(new Date('2026-02-03T00:00:00.000Z').getTime());
  });

  it('null-строка → начало текущего календарного месяца (не падает)', () => {
    const out = getBillingPeriodStart(null);
    expect(typeof out).toBe('string');
    expect(Number.isNaN(new Date(out).getTime())).toBe(false);
  });
});

describe('isClientToolAccessAllowed — оплаченные (active+setup) пускаются, неоплаченные нет', () => {
  it('active → true', () => {
    expect(isClientToolAccessAllowed('active')).toBe(true);
  });
  it('setup → true (в прогрев почт можно готовить базы/цепочки)', () => {
    expect(isClientToolAccessAllowed('setup')).toBe(true);
  });
  it('inactive → false', () => {
    expect(isClientToolAccessAllowed('inactive')).toBe(false);
  });
  it('expired → false', () => {
    expect(isClientToolAccessAllowed('expired')).toBe(false);
  });
});

describe('isAwaitingFirstPayment — оформил, но ни разу не оплатил', () => {
  it('payment_locked=true + paid_at=null → true (доступа нет)', () => {
    expect(isAwaitingFirstPayment({ payment_locked: true, paid_at: null })).toBe(true);
  });
  it('оплатил (paid_at выставлен) → false, даже если payment_locked ещё true (прогрев автоплатежа)', () => {
    expect(isAwaitingFirstPayment({ payment_locked: true, paid_at: '2026-06-10T00:00:00Z' })).toBe(false);
  });
  it('админ снял блокировку (payment_locked=false, paid_at=null, комп) → false', () => {
    expect(isAwaitingFirstPayment({ payment_locked: false, paid_at: null })).toBe(false);
  });
  it('обычный оплаченный (locked=false, paid_at есть) → false', () => {
    expect(isAwaitingFirstPayment({ payment_locked: false, paid_at: '2026-06-10T00:00:00Z' })).toBe(false);
  });
  it('null-строка → false (не падает)', () => {
    expect(isAwaitingFirstPayment(null)).toBe(false);
  });
});

describe('BillingPeriod tables', () => {
  it('BILLING_PERIOD_MONTHS.quarter === 3', () => {
    expect(BILLING_PERIOD_MONTHS.quarter).toBe(3);
  });

  it('BILLING_PERIOD_DISCOUNT: month/quarter = 1, half_year = 0.9, year = 0.8', () => {
    expect(BILLING_PERIOD_DISCOUNT.month).toBe(1);
    expect(BILLING_PERIOD_DISCOUNT.quarter).toBe(1);
    expect(BILLING_PERIOD_DISCOUNT.half_year).toBe(0.9);
    expect(BILLING_PERIOD_DISCOUNT.year).toBe(0.8);
  });
});

describe('calcBillingAmount — без скидки (1 мес, 3 мес)', () => {
  it('standard, 1 мес → 40 000', () => {
    expect(calcBillingAmount('standard', 'month')).toBe(40_000);
  });

  it('pro, 1 мес → 65 000 (выровнено с лендингом outreachos.pro)', () => {
    expect(calcBillingAmount('pro', 'month')).toBe(65_000);
  });

  it('standard, 3 мес → 120 000', () => {
    expect(calcBillingAmount('standard', 'quarter')).toBe(120_000);
  });

  it('pro, 3 мес → 195 000', () => {
    expect(calcBillingAmount('pro', 'quarter')).toBe(195_000);
  });
});

describe('calcBillingAmount — со скидкой (6 мес = -10%, 12 мес = -20%)', () => {
  it('standard, 6 мес → 216 000 (40k × 6 × 0.9)', () => {
    expect(calcBillingAmount('standard', 'half_year')).toBe(216_000);
  });

  it('pro, 6 мес → 351 000 (65k × 6 × 0.9)', () => {
    expect(calcBillingAmount('pro', 'half_year')).toBe(351_000);
  });

  it('standard, 12 мес → 384 000 (40k × 12 × 0.8)', () => {
    expect(calcBillingAmount('standard', 'year')).toBe(384_000);
  });

  it('pro, 12 мес → 624 000 (65k × 12 × 0.8)', () => {
    expect(calcBillingAmount('pro', 'year')).toBe(624_000);
  });
});

describe('calcBillingAmount — custom', () => {
  it('возвращает null (сумма проставляется вручную)', () => {
    expect(calcBillingAmount('custom', 'month')).toBeNull();
    expect(calcBillingAmount('custom', 'year')).toBeNull();
  });
});

describe('calcBillingAmount — тестовый магазин (isTestShop=true)', () => {
  it('standard: 10/15/20 ₽ для month/half_year/year', () => {
    expect(calcBillingAmount('standard', 'month', true)).toBe(10);
    expect(calcBillingAmount('standard', 'half_year', true)).toBe(15);
    expect(calcBillingAmount('standard', 'year', true)).toBe(20);
  });

  it('pro: 11/16/21 ₽ для month/half_year/year', () => {
    expect(calcBillingAmount('pro', 'month', true)).toBe(11);
    expect(calcBillingAmount('pro', 'half_year', true)).toBe(16);
    expect(calcBillingAmount('pro', 'year', true)).toBe(21);
  });

  it('quarter в тест-магазине не поддержан → null (в админ-UI его нет)', () => {
    expect(calcBillingAmount('standard', 'quarter', true)).toBeNull();
    expect(calcBillingAmount('pro', 'quarter', true)).toBeNull();
  });

  it('custom игнорирует isTestShop, всегда null', () => {
    expect(calcBillingAmount('custom', 'month', true)).toBeNull();
    expect(calcBillingAmount('custom', 'year', true)).toBeNull();
  });

  it('isTestShop=false (дефолт) даёт прод-цены без изменений', () => {
    expect(calcBillingAmount('standard', 'month', false)).toBe(40_000);
    expect(calcBillingAmount('pro', 'year', false)).toBe(624_000);
  });
});

describe('Test-shop константы', () => {
  it('TEST_TARIFF_PRICE.standard = { month: 10, half_year: 15, year: 20 }', () => {
    expect(TEST_TARIFF_PRICE.standard).toEqual({ month: 10, half_year: 15, year: 20 });
  });

  it('TEST_TARIFF_PRICE.pro = { month: 11, half_year: 16, year: 21 }', () => {
    expect(TEST_TARIFF_PRICE.pro).toEqual({ month: 11, half_year: 16, year: 21 });
  });

  it('TEST_PERIOD_MINUTES_BY_PERIOD: month=10, half_year=15, year=20', () => {
    expect(TEST_PERIOD_MINUTES_BY_PERIOD.month).toBe(10);
    expect(TEST_PERIOD_MINUTES_BY_PERIOD.half_year).toBe(15);
    expect(TEST_PERIOD_MINUTES_BY_PERIOD.year).toBe(20);
  });

  it('TEST_SETUP_MINUTES === 5', () => {
    expect(TEST_SETUP_MINUTES).toBe(5);
  });
});
