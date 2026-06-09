/**
 * @jest-environment node
 *
 * Guardrail for the auth hot-path parallelization (requireClientAuth now reads
 * profiles + client_instantly_access concurrently via Promise.all). There was
 * NO direct test of requireClientAuth before — clientPortalSmoke fully mocks it,
 * so it covered none of the ordering this change touches. These cases lock in:
 *   - the returned auth shape (userId / accessRows / isDemo),
 *   - that BOTH reads still happen (parallelization didn't drop accessRows),
 *   - the demo write-block STILL returns 403 even though accessRows is now
 *     fetched alongside profiles instead of after the guard,
 *   - the demo read-only POST allowlist still passes through,
 *   - Forbidden role and unauthenticated paths.
 */
import type { NextRequest } from 'next/server';

// Mutable per-test state (must be `mock`-prefixed so jest.mock factories may
// reference them despite hoisting).
let mockUser: { id: string } | null = { id: 'user-1' };
let mockProfile: { role: string | null; is_demo: boolean } | null = { role: 'client', is_demo: false };
const mockAccessRows = [
  { resource_type: 'campaign', resource_id: 'c1', instantly_account_id: 'a1' },
];
const mockFromCalls: string[] = [];

// Minimal chainable supabase query-builder stub: builder methods return the
// builder; awaiting it (Promise.all) or calling .single() resolves the result.
function mockQb(result: unknown) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.in = self;
  builder.gte = self;
  builder.order = self;
  builder.single = () => Promise.resolve(result);
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (v: unknown) => void) => resolve(result);
  return builder;
}

jest.mock('@/lib/apiTiming', () => ({
  withApiTiming: (_name: string, fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'token-123',
  createAuthedSupabaseClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockUser } }) },
  }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mockFromCalls.push(`admin:${table}`);
      return mockQb({ data: mockProfile, error: null });
    },
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: {
    from: (table: string) => {
      mockFromCalls.push(`instantly:${table}`);
      return mockQb({ data: mockAccessRows, error: null });
    },
  },
}));

import { requireClientAuth } from '@/lib/clientApiHelper';

function makeReq(method: string, pathname = '/api/client/things'): NextRequest {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === 'authorization' ? 'Bearer token-123' : null),
    },
    method,
    nextUrl: { pathname },
  } as unknown as NextRequest;
}

describe('requireClientAuth (parallelized profile + accessRows)', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' };
    mockProfile = { role: 'client', is_demo: false };
    mockFromCalls.length = 0;
  });

  it('returns auth with userId, accessRows and isDemo for a normal client GET', async () => {
    const res = await requireClientAuth(makeReq('GET'));
    expect('auth' in res).toBe(true);
    if ('auth' in res) {
      expect(res.auth.userId).toBe('user-1');
      expect(res.auth.isDemo).toBe(false);
      expect(res.auth.accessRows).toHaveLength(1);
      expect(res.auth.accessRows[0].resource_id).toBe('c1');
    }
  });

  it('still reads BOTH profiles and client_instantly_access (parallelization kept the access read)', async () => {
    await requireClientAuth(makeReq('GET'));
    expect(mockFromCalls).toContain('admin:profiles');
    expect(mockFromCalls).toContain('instantly:client_instantly_access');
  });

  it('blocks a demo mutating request with 403', async () => {
    mockProfile = { role: 'client', is_demo: true };
    const res = await requireClientAuth(makeReq('POST'));
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error.status).toBe(403);
  });

  it('lets a demo read-only POST path (reports) through to the route', async () => {
    mockProfile = { role: 'client', is_demo: true };
    const res = await requireClientAuth(makeReq('POST', '/api/client/reports'));
    expect('auth' in res).toBe(true);
  });

  it('returns 403 Forbidden for a non-client/non-admin role', async () => {
    mockProfile = { role: 'technician', is_demo: false };
    const res = await requireClientAuth(makeReq('GET'));
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error.status).toBe(403);
  });

  it('returns 401 when there is no authenticated user', async () => {
    mockUser = null;
    const res = await requireClientAuth(makeReq('GET'));
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error.status).toBe(401);
  });
});
