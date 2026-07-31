/** @jest-environment node */

/**
 * Страховка от рассинхрона витрины и типа.
 *
 * `fetchExpenseRows` кастует ответ PostgREST к `ExpenseRow[]` без проверки:
 * если список полей в `.select(...)` разойдётся с типом, TypeScript промолчит,
 * а дашборд покажет 0 ₽ — ни исключения, ни строчки в логах.
 *
 * Тест ловит обе стороны расхождения:
 *  - поле добавили/переименовали в `ExpenseRow`, но не в `.select(...)` —
 *    красный `tsc` на карте `EXPECTED_COLUMNS` ниже, потом красный jest;
 *  - поле убрали из `.select(...)`, а тип оставили — красный jest.
 *
 * Аргумент `.select()` берётся не из исходника, а из реального вызова: тест
 * перехватывает его моком supabaseAdmin, поэтому проверяет то, что на самом
 * деле уходит в базу.
 */

import type { ExpenseRow } from '@/lib/expenses/types';

const captured: { select: string | null } = { select: null };

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
    eq: () => query,
    in: () => query,
    is: () => query,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };
  return query;
}

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => makeQuery() },
}));

import { fetchExpenseRows } from '@/lib/expenses/rows';

/**
 * Тип `Record<keyof ExpenseRow, true>` требует перечислить ровно ключи
 * `ExpenseRow`: пропущенный или лишний — ошибка компиляции, а не тихий ноль.
 */
const EXPECTED_COLUMNS: Record<keyof ExpenseRow, true> = {
  source: true,
  source_ref: true,
  occurred_on_msk: true,
  amount: true,
  currency: true,
  counterparty: true,
  counterparty_inn: true,
  details: true,
  vendor_id: true,
  vendor_name: true,
  category: true,
  classification_method: true,
  amount_rub: true,
};

it('список полей в .select() совпадает с ключами ExpenseRow', async () => {
  await fetchExpenseRows({ from: '2026-07-01', to: '2026-07-31' });

  expect(captured.select).not.toBeNull();
  const selected = (captured.select ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
    .sort();

  expect(selected).toEqual(Object.keys(EXPECTED_COLUMNS).sort());
});
