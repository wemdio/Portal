import {
  calcBillingAmount,
  BILLING_PERIOD_MONTHS,
  BILLING_PERIOD_DISCOUNT,
  TEST_TARIFF_PRICE,
  TEST_PERIOD_MINUTES_BY_PERIOD,
  TEST_SETUP_MINUTES,
} from '@/lib/tariffs';

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
