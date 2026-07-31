/** @jest-environment node */

const getUser = jest.fn();
const maybeSingle = jest.fn();
const single = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (h: string | null) => (h ? h.replace('Bearer ', '') : null),
  createAuthedSupabaseClient: () => ({ auth: { getUser } }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle }),
          single,
          maybeSingle,
        }),
      }),
      _table: table,
    }),
  },
}));

import { requireFirstSalesAccess } from '@/lib/firstSales/access';

const req = (auth: string | null) =>
  ({ headers: { get: () => auth } }) as unknown as Parameters<typeof requireFirstSalesAccess>[0];

describe('requireFirstSalesAccess', () => {
  beforeEach(() => {
    getUser.mockReset();
    maybeSingle.mockReset();
    single.mockReset();
  });

  // Гард возвращает размеченное объединение, поэтому сужаем через `'error' in res`
  // — тот же приём, что в src/app/api/database-review/requests/route.ts:15.
  // Работает только благодаря явной аннотации возвращаемого типа в access.ts
  // (см. комментарий там) — без неё tsc не сужает `res.error` при 4+ точках
  // `return { error }` в исходной функции.
  const statusOf = (res: Awaited<ReturnType<typeof requireFirstSalesAccess>>) =>
    'error' in res ? res.error.status : null;

  it('без токена — 401', async () => {
    expect(statusOf(await requireFirstSalesAccess(req(null)))).toBe(401);
  });

  it('админ проходит без строки видимости', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    single.mockResolvedValue({ data: { role: 'admin' }, error: null });
    maybeSingle.mockResolvedValue({ data: null });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBeNull();
  });

  it('обычный пользователь с enabled=true проходит', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u2' } } });
    single.mockResolvedValue({ data: { role: 'specialist' }, error: null });
    maybeSingle.mockResolvedValue({ data: { enabled: true } });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBeNull();
  });

  it('обычный пользователь без строки — 403', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u3' } } });
    single.mockResolvedValue({ data: { role: 'specialist' }, error: null });
    maybeSingle.mockResolvedValue({ data: null });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBe(403);
  });

  it('обычный пользователь с enabled=false — 403', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u4' } } });
    single.mockResolvedValue({ data: { role: 'specialist' }, error: null });
    maybeSingle.mockResolvedValue({ data: { enabled: false } });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBe(403);
  });
});
