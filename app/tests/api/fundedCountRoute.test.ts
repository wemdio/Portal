/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (h: string | null) => h,
  createAuthedSupabaseClient: () => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

function fakeQuery(result: { count?: number; error?: { message: string } }) {
  const calls: [string, ...unknown[]][] = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  for (const m of ['in', 'or', 'gte', 'ilike']) {
    q[m] = (...args: unknown[]) => { calls.push([m, ...args]); return q; };
  }
  // awaiting the builder resolves the query (postgrest builders are thenables)
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { q, calls };
}

function req(path: string, withAuth = true): NextRequest {
  return new NextRequest(`http://x${path}`, withAuth ? { headers: { authorization: 'Bearer t' } } : {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
});

describe('GET /api/funded/count', () => {
  it('401s without a bearer token', async () => {
    const { GET } = await import('@/app/api/funded/count/route');
    const res = await GET(req('/api/funded/count', false));
    expect(res.status).toBe(401);
  });

  it('returns the EXACT count from postgrest, not the planner estimate RPC', async () => {
    const { q } = fakeQuery({ count: 5 });
    mockFrom.mockReturnValue(q);
    const { GET } = await import('@/app/api/funded/count/route');
    const res = await GET(req('/api/funded/count?industry=b2b&funded_since=2024-08-02'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ estimate: 5, exact: true }));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('passes the same filters the search route would (industry + recency = honest 0-correlation count)', async () => {
    const { q, calls } = fakeQuery({ count: 0 });
    mockFrom.mockReturnValue(q);
    const { GET } = await import('@/app/api/funded/count/route');
    await GET(req('/api/funded/count?industry=b2b&funded_since=2024-08-02&min_funding=100000&name=acme'));
    expect(calls).toEqual([
      ['in', 'industry', ['b2b']],
      ['or', 'last_funding_usd.gte.100000,total_funding_usd.gte.100000'],
      ['gte', 'last_funding_date', '2024-08-02'],
      ['ilike', 'name', '%acme%'],
    ]);
  });

  it('500s on a postgrest error', async () => {
    const { q } = fakeQuery({ error: { message: 'db down' } });
    mockFrom.mockReturnValue(q);
    const { GET } = await import('@/app/api/funded/count/route');
    const res = await GET(req('/api/funded/count'));
    expect(res.status).toBe(500);
  });
});
