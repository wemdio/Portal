/** @jest-environment node */

import { NextRequest } from 'next/server';

const state: {
  user: { id: string } | null;
  profile: { role: string } | null;
  visibility: { enabled: boolean } | null;
} = { user: { id: 'u-1' }, profile: { role: 'manager' }, visibility: null };

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => (header ? 'tok' : null),
  createAuthedSupabaseClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: state.profile }),
          eq: () => ({ maybeSingle: async () => ({ data: state.visibility }) }),
        }),
      }),
    }),
  },
}));

import { requireExpensesAccess } from '@/lib/expenses/access';

function req(withAuth = true) {
  return new NextRequest('http://localhost/api/expenses/summary', {
    headers: withAuth ? { authorization: 'Bearer tok' } : {},
  });
}

beforeEach(() => {
  state.user = { id: 'u-1' };
  state.profile = { role: 'manager' };
  state.visibility = null;
});

it('401 без токена', async () => {
  const res = await requireExpensesAccess(req(false));
  expect(res).toMatchObject({ ok: false, status: 401 });
});

it('403 пользователю без выданного тумблера', async () => {
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('403 пользователю с выключенным тумблером', async () => {
  state.visibility = { enabled: false };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('пропускает пользователя с выданным тумблером', async () => {
  state.visibility = { enabled: true };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: true, userId: 'u-1', role: 'manager' });
});

it('пропускает админа без строки в БД', async () => {
  state.profile = { role: 'admin' };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: true, role: 'admin' });
});
