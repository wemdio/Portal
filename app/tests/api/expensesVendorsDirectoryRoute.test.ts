/** @jest-environment node */

/**
 * Справочник вендоров. Проверяется не содержимое (его отдаёт Postgres), а
 * выборка: гард, фильтр по `is_active` и сортировка по названию.
 *
 * Условие `is_active` тут единственная защита от того, чтобы выключенный
 * вендор снова оказался в выпадающем списке, а его пропажа — ровно тот тип
 * ошибки, который не падает, а тихо предлагает лишнее.
 */

import { NextRequest } from 'next/server';

interface OrderCall {
  column: string;
  ascending?: boolean;
}

const state: {
  guard: { ok: true; userId: string; role: string } | { ok: false; status: number; error: string };
  table: string | null;
  columns: string | null;
  filters: Array<[string, unknown]>;
  order: OrderCall[];
  data: Array<{ id: string; name: string; category: string | null }> | null;
  error: { message: string } | null;
} = {
  guard: { ok: true, userId: 'u-1', role: 'admin' },
  table: null,
  columns: null,
  filters: [],
  order: [],
  data: [],
  error: null,
};

jest.mock('@/lib/expenses/access', () => ({
  requireExpensesAccess: async () => state.guard,
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      state.table = table;
      const builder = {
        select: (columns: string) => {
          state.columns = columns;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          state.filters.push([column, value]);
          return builder;
        },
        // Сортировка идёт последней, поэтому именно она и разрешается ответом.
        order: (column: string, options?: { ascending?: boolean }) => {
          state.order.push({ column, ...options });
          return Promise.resolve({ data: state.data, error: state.error });
        },
      };
      return builder;
    },
  },
}));

import { GET } from '@/app/api/expenses/vendors/directory/route';

function req() {
  return new NextRequest('http://localhost/api/expenses/vendors/directory');
}

beforeEach(() => {
  state.guard = { ok: true, userId: 'u-1', role: 'admin' };
  state.table = null;
  state.columns = null;
  state.filters = [];
  state.order = [];
  state.data = [];
  state.error = null;
});

it('отдаёт отказ гарда как есть и в базу не ходит', async () => {
  state.guard = { ok: false, status: 403, error: 'Раздел «Деньги» доступен только админам' };
  const res = await GET(req());
  expect(res.status).toBe(403);
  expect(state.table).toBeNull();
});

it('отдаёт активных вендоров с категорией, отсортированных по названию', async () => {
  state.data = [
    { id: 'v-1', name: 'Anthropic', category: 'tools' },
    { id: 'v-2', name: 'Яндекс.Директ', category: 'marketing' },
  ];

  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: state.data });

  expect(state.table).toBe('expense_vendors');
  expect(state.columns).toBe('id, name, category');
  expect(state.filters).toEqual([['is_active', true]]);
  expect(state.order).toEqual([{ column: 'name', ascending: true }]);
});

it('период не участвует в выборке: справочник от дат не зависит', async () => {
  await GET(new NextRequest('http://localhost/api/expenses/vendors/directory?from=2026-07-01&to=2026-07-31'));
  expect(state.filters).toEqual([['is_active', true]]);
});

it('пустая таблица — пустой список, а не 500', async () => {
  state.data = null;
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: [] });
});

it('ошибка базы — 500 с её текстом', async () => {
  state.error = { message: 'permission denied for table expense_vendors' };
  const res = await GET(req());
  expect(res.status).toBe(500);
  expect((await res.json()).error).toContain('permission denied');
});
