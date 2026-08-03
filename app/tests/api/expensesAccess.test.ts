/** @jest-environment node */

/**
 * Раздел «Деньги» закрыт ролью и только ролью.
 *
 * Тумблер `nav-expenses` в `user_tool_visibility` в решении больше не
 * участвует. Случаи с выданным и выключенным тумблером оставлены нарочно: они
 * фиксируют, что строка в этой таблице ничего не даёт. Если точечную выдачу
 * когда-нибудь вернут, эти два теста покраснеют.
 */

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
    from: () => ({
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

it('403 не-админу без строки в user_tool_visibility', async () => {
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('403 не-админу с выданным тумблером: строка в user_tool_visibility доступа не даёт', async () => {
  state.visibility = { enabled: true };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('403 не-админу с выключенным тумблером', async () => {
  state.visibility = { enabled: false };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('403, если профиля нет: роль неизвестна — значит не админ', async () => {
  state.profile = null;
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('пропускает админа', async () => {
  state.profile = { role: 'admin' };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: true, userId: 'u-1', role: 'admin' });
});
