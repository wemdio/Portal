/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient = createMockSupabase();
jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { applyInvoicePaidToTariff } from '@/lib/tariffs';

const USER = 'u-invoice';
const SETUP = '2026-06-18T00:00:00.000Z';

function seed(overrides: Record<string, unknown>) {
  mockDb = createMockSupabase({
    tables: {
      client_tariffs: [
        {
          user_id: USER,
          id: 't1',
          billing_mode: 'invoice',
          payment_locked: true,
          paid_at: null,
          setup_until: SETUP,
          paid_until: null,
          test_period_minutes: null,
          billing_period: 'month',
          ...overrides,
        },
      ],
    },
  });
}

function paidUntil(): string {
  const call = mockDb.updates.find((u) => u.table === 'client_tariffs');
  return String(call?.patch.paid_until ?? '');
}

describe('applyInvoicePaidToTariff — первая оплата зачисляет ПОЛНЫЙ период', () => {
  it('месяц: paid_until = setup_until + 1 месяц', async () => {
    seed({ billing_period: 'month' });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2026-07-18T00:00:00.000Z');
  });

  it('квартал: setup_until + 3 месяца (регресс: раньше зачислялся только 1)', async () => {
    seed({ billing_period: 'quarter' });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('полгода: setup_until + 6 месяцев', async () => {
    seed({ billing_period: 'half_year' });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2026-12-18T00:00:00.000Z');
  });

  it('год: setup_until + 12 месяцев', async () => {
    seed({ billing_period: 'year' });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2027-06-18T00:00:00.000Z');
  });

  it('ручной режим (billing_period=null): 1 месяц, как прежде', async () => {
    seed({ billing_period: null });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2026-07-18T00:00:00.000Z');
  });

  it('продление (paid_at задан): от текущего paid_until на полный период', async () => {
    seed({
      billing_period: 'quarter',
      paid_at: '2026-06-18T00:00:00.000Z',
      paid_until: '2026-09-18T00:00:00.000Z',
    });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2026-12-18T00:00:00.000Z');
  });

  it('тест-минуты приоритетнее периода: += минуты, не месяцы', async () => {
    seed({ billing_period: 'quarter', test_period_minutes: 15 });
    await applyInvoicePaidToTariff(USER);
    expect(paidUntil()).toBe('2026-06-18T00:15:00.000Z');
  });
});
