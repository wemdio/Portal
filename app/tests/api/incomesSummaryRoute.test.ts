/** @jest-environment node */

/**
 * Роут сводки по доходам. Проверяется не арифметика (она покрыта в
 * `tests/lib/incomesAggregate.test.ts`), а склейка, которую легко сломать:
 * гард, разбор параметров и досчёт KPI не-выручки под фильтром `revenue=true`
 * — без него KPI показывал бы 0 ₽ там, где приход был.
 */

import { NextRequest } from 'next/server';

import type { IncomeRow } from '@/lib/expenses/types';

interface Filters {
  from: string;
  to: string;
  source?: string | null;
  payerInn?: string | null;
  payerName?: string | null;
  revenue?: boolean | null;
}

const state: {
  guard: { ok: true; userId: string; role: string } | { ok: false; status: number; error: string };
  calls: Filters[];
} = { guard: { ok: true, userId: 'u-1', role: 'admin' }, calls: [] };

function row(over: Partial<IncomeRow>): IncomeRow {
  return {
    source: 'tochka',
    source_ref: 'r1',
    occurred_on_msk: '2026-07-15',
    amount: 100,
    currency: 'RUB',
    counterparty: 'ООО Ромашка',
    counterparty_inn: '7701234567',
    details: null,
    is_revenue: true,
    exclude_reason: null,
    amount_rub: 100,
    ...over,
  };
}

const REVENUE = row({ source_ref: 'a', amount_rub: 100 });
const NON_REVENUE = row({
  source_ref: 'b',
  amount_rub: 900,
  is_revenue: false,
  exclude_reason: 'возврат',
});

jest.mock('@/lib/expenses/access', () => ({
  requireExpensesAccess: async () => state.guard,
}));

jest.mock('@/lib/expenses/rows', () => ({
  fetchIncomeRows: async (filters: Filters) => {
    state.calls.push(filters);
    // Прошлый период пуст — тесту важен только текущий.
    if (filters.from !== '2026-07-15') return [];
    if (filters.revenue === true) return [REVENUE];
    if (filters.revenue === false) return [NON_REVENUE];
    return [REVENUE, NON_REVENUE];
  },
}));

import { GET } from '@/app/api/expenses/incomes/summary/route';

function req(qs: string) {
  return new NextRequest(`http://localhost/api/expenses/incomes/summary?${qs}`);
}

const PERIOD = 'from=2026-07-15&to=2026-07-15';

beforeEach(() => {
  state.guard = { ok: true, userId: 'u-1', role: 'admin' };
  state.calls = [];
});

it('отдаёт отказ гарда как есть', async () => {
  state.guard = { ok: false, status: 403, error: 'Раздел «Деньги» доступен только админам' };
  const res = await GET(req(PERIOD));
  expect(res.status).toBe(403);
  expect(state.calls).toHaveLength(0);
});

it('битый период — 400, а не пятисотка', async () => {
  const res = await GET(req('from=2026-02-31&to=2026-07-15'));
  expect(res.status).toBe(400);
});

it('без фильтра: итог без не-выручки, не-выручка отдельным числом', async () => {
  const res = await GET(req(PERIOD));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total).toBe(100);
  expect(body.nonRevenueTotal).toBe(900);
  expect(body.nonRevenueByReason).toEqual({ возврат: 900 });
  // Текущий период + предыдущий, третьего запроса не нужно.
  expect(state.calls).toHaveLength(2);
});

it('под revenue=true не-выручка досчитывается отдельным запросом', async () => {
  const res = await GET(req(`${PERIOD}&revenue=true`));
  const body = await res.json();
  expect(body.total).toBe(100);
  expect(body.nonRevenueTotal).toBe(900);
  expect(body.nonRevenueCount).toBe(1);
  expect(state.calls).toHaveLength(3);
  expect(state.calls[2]).toMatchObject({ from: '2026-07-15', to: '2026-07-15', revenue: false });
});

it('фильтры плательщика доходят до выборки', async () => {
  await GET(req(`${PERIOD}&payerInn=7701234567&source=tbank`));
  expect(state.calls[0]).toMatchObject({ payerInn: '7701234567', source: 'tbank' });
});

it('мусорный ИНН — 400', async () => {
  const res = await GET(req(`${PERIOD}&payerInn=абв`));
  expect(res.status).toBe(400);
});
