/** @jest-environment node */

/**
 * Страховка от рассинхрона витрины доходов и типа — ровно та же, что у
 * расходов (`expensesRowsSelect.test.ts`): `fetchIncomeRows` кастует ответ
 * PostgREST к `IncomeRow[]` без проверки, и разъехавшееся имя колонки дало бы
 * дашборду 0 ₽ без единой ошибки в логах.
 *
 * Заодно фиксируется фильтр по выручке: `revenue: true` обязан пропускать
 * строки с `is_revenue = NULL`, потому что их считает выручкой агрегация.
 * `.eq('is_revenue', true)` их бы отбросил, и сумма под фильтром разошлась бы
 * с суммой без фильтра.
 */

import type { IncomeRow } from '@/lib/expenses/types';

const captured: { select: string | null; filters: string[] } = { select: null, filters: [] };

function makeQuery() {
  const query = {
    select: (columns: string) => {
      captured.select = columns;
      return query;
    },
    gte: () => query,
    lte: () => query,
    order: () => query,
    range: () => query,
    eq: (column: string, value: unknown) => {
      captured.filters.push(`eq:${column}=${String(value)}`);
      return query;
    },
    in: () => query,
    is: (column: string, value: unknown) => {
      captured.filters.push(`is:${column}=${String(value)}`);
      return query;
    },
    not: (column: string, operator: string, value: unknown) => {
      captured.filters.push(`not:${column}=${operator}.${String(value)}`);
      return query;
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };
  return query;
}

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => makeQuery() },
}));

import { fetchIncomeRows } from '@/lib/expenses/rows';

/** `Record<keyof IncomeRow, true>` требует перечислить ровно ключи типа. */
const EXPECTED_COLUMNS: Record<keyof IncomeRow, true> = {
  source: true,
  source_ref: true,
  occurred_on_msk: true,
  amount: true,
  currency: true,
  counterparty: true,
  counterparty_inn: true,
  details: true,
  is_revenue: true,
  exclude_reason: true,
  amount_rub: true,
};

beforeEach(() => {
  captured.select = null;
  captured.filters = [];
});

it('список полей в .select() совпадает с ключами IncomeRow', async () => {
  await fetchIncomeRows({ from: '2026-07-01', to: '2026-07-31' });

  expect(captured.select).not.toBeNull();
  const selected = (captured.select ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
    .sort();

  expect(selected).toEqual(Object.keys(EXPECTED_COLUMNS).sort());
});

it('revenue: true пропускает NULL — фильтр думает так же, как агрегация', async () => {
  await fetchIncomeRows({ from: '2026-07-01', to: '2026-07-31', revenue: true });
  expect(captured.filters).toEqual(['not:is_revenue=is.false']);
});

it('revenue: false отбирает только классифицированную не-выручку', async () => {
  await fetchIncomeRows({ from: '2026-07-01', to: '2026-07-31', revenue: false });
  expect(captured.filters).toEqual(['is:is_revenue=false']);
});

it('без фильтра по выручке отдаются все строки периода', async () => {
  await fetchIncomeRows({ from: '2026-07-01', to: '2026-07-31' });
  expect(captured.filters).toEqual([]);
});

it('дрилл-даун по плательщику: ИНН и имя — независимые фильтры', async () => {
  await fetchIncomeRows({ from: '2026-07-01', to: '2026-07-31', payerInn: '7701234567' });
  expect(captured.filters).toEqual(['eq:counterparty_inn=7701234567']);

  captured.filters = [];
  await fetchIncomeRows({ from: '2026-07-01', to: '2026-07-31', payerName: 'ЕРХОВ НИКИТА' });
  expect(captured.filters).toEqual(['eq:counterparty=ЕРХОВ НИКИТА']);
});
