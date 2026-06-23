import { calcBillingAmount, BILLING_PERIOD_MONTHS, BILLING_PERIOD_DISCOUNT } from '@/lib/tariffs';

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
