/** @jest-environment node */

/**
 * Права на правку ручных трат. Всё остальное в роуте — склейка уже покрытых
 * кусков, а вот «кто может стереть чужую запись» стоит держать под тестом:
 * ошибка здесь не падает, а тихо разрешает лишнее.
 */

import { NextRequest } from 'next/server';

const state: {
  guard: { ok: true; userId: string; role: string } | { ok: false; status: number; error: string };
  existing: { created_by: string } | null;
  deleted: boolean;
} = {
  guard: { ok: true, userId: 'u-1', role: 'manager' },
  existing: { created_by: 'u-1' },
  deleted: false,
};

jest.mock('@/lib/expenses/access', () => ({
  requireExpensesAccess: async () => state.guard,
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.existing, error: null }) }) }),
      delete: () => ({
        eq: async () => {
          state.deleted = true;
          return { error: null };
        },
      }),
    }),
  },
}));

import { DELETE } from '@/app/api/expenses/manual/[id]/route';

function req() {
  return new NextRequest('http://localhost/api/expenses/manual/e-1', { method: 'DELETE' });
}
const ctx = { params: Promise.resolve({ id: 'e-1' }) };

beforeEach(() => {
  state.guard = { ok: true, userId: 'u-1', role: 'manager' };
  state.existing = { created_by: 'u-1' };
  state.deleted = false;
});

it('автор может удалить свою запись', async () => {
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(200);
  expect(state.deleted).toBe(true);
});

it('чужую запись удалить нельзя', async () => {
  state.existing = { created_by: 'someone-else' };
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(403);
  expect(state.deleted).toBe(false);
});

it('админ может удалить чужую запись', async () => {
  state.guard = { ok: true, userId: 'u-1', role: 'admin' };
  state.existing = { created_by: 'someone-else' };
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(200);
});

it('несуществующая запись — 404', async () => {
  state.existing = null;
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(404);
});
