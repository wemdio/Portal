import { calcBillingAmount, BILLING_PERIOD_MONTHS } from '@/lib/tariffs';

describe('BillingPeriod quarter', () => {
  it('BILLING_PERIOD_MONTHS.quarter === 3', () => {
    expect(BILLING_PERIOD_MONTHS.quarter).toBe(3);
  });

  it('calcBillingAmount(standard, quarter) === 120_000', () => {
    expect(calcBillingAmount('standard', 'quarter')).toBe(120_000);
  });

  it('calcBillingAmount(pro, quarter) === 240_000', () => {
    expect(calcBillingAmount('pro', 'quarter')).toBe(240_000);
  });
});
