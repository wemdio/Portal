/** @jest-environment node */

/**
 * Security regression test for LinkedIn Outreach API routes.
 *
 * Ensures every list/aggregate/by-id endpoint scopes its Supabase query
 * by `user_id = auth.user.id` (or via owned-campaign filter) so a user
 * cannot see or mutate another user's accounts, campaigns, leads, lead
 * lists, scraper tasks, or campaign logs.
 *
 * The test uses a chainable mock of `supabaseAdmin` that records every
 * `.eq()` / `.in()` filter call and returns deterministic data. We then
 * import each route handler and assert that the relevant filter is
 * applied for the authenticated user.
 */

const AUTH_USER_ID = 'user-A';
const OTHER_USER_ID = 'user-B';

type EqCall = { table: string; column: string; value: unknown };
type InCall = { table: string; column: string; values: unknown[] };

interface ChainState {
  table: string;
  eqCalls: EqCall[];
  inCalls: InCall[];
}

const state = {
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  allEqCalls: [] as EqCall[],
  allInCalls: [] as InCall[],
};

function resetState() {
  state.rowsByTable = {};
  state.allEqCalls = [];
  state.allInCalls = [];
}

function makeBuilder(table: string) {
  const local: ChainState = { table, eqCalls: [], inCalls: [] };

  const finalize = () => {
    let rows = state.rowsByTable[table] ?? [];
    for (const eq of local.eqCalls) {
      rows = rows.filter((r) => r[eq.column] === eq.value);
    }
    for (const inFilter of local.inCalls) {
      rows = rows.filter((r) => inFilter.values.includes(r[inFilter.column]));
    }
    return { data: rows, error: null, count: rows.length };
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    range: async () => finalize(),
    eq: (column: string, value: unknown) => {
      local.eqCalls.push({ table, column, value });
      state.allEqCalls.push({ table, column, value });
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      local.inCalls.push({ table, column, values });
      state.allInCalls.push({ table, column, values });
      return builder;
    },
    gte: () => builder,
    or: () => builder,
    update: () => builder,
    insert: () => builder,
    upsert: () => builder,
    delete: () => builder,
    single: async () => {
      const result = finalize();
      const first = result.data[0] ?? null;
      return { data: first, error: first ? null : { message: 'not found' } };
    },
    maybeSingle: async () => {
      const result = finalize();
      return { data: result.data[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      resolve(finalize());
    },
  };

  return builder;
}

const fromMock = jest.fn((table: string) => makeBuilder(table));

// Mutable flag toggled per-test so we can exercise both the regular-user path
// (default) and the admin-bypass branch added in the "admins manage all LI
// campaigns" feature. See the second describe block below.
const adminFlag = { value: false };

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => fromMock(table) },
}));

jest.mock('@/lib/liOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({
      user: { id: AUTH_USER_ID },
      supabase: { from: (table: string) => fromMock(table) },
    })),
    checkIsAdmin: jest.fn(async () => adminFlag.value),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _opts: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
  startToolTrace: async () => ({ end: async () => {}, fail: async () => {} }),
}));

import { NextRequest } from 'next/server';

function makeReq(url: string, init?: RequestInit): NextRequest {
  const req = new Request(url, {
    headers: { authorization: 'Bearer test-token', ...(init?.headers ?? {}) },
    ...init,
  });
  return req as unknown as NextRequest;
}

function ownsUserScope(table: string): boolean {
  return state.allEqCalls.some(
    (c) => c.table === table && c.column === 'user_id' && c.value === AUTH_USER_ID,
  );
}

beforeEach(() => {
  resetState();
  fromMock.mockClear();
  adminFlag.value = false;
});

describe('LI Outreach — user_id isolation on list endpoints', () => {
  it('GET /accounts only returns rows for the authenticated user', async () => {
    state.rowsByTable.li_accounts = [
      { id: 'a1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'a2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/accounts/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/accounts'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_accounts')).toBe(true);
    expect((body.accounts as Array<{ id: string }>).map((a) => a.id)).toEqual(['a1']);
  });

  it('GET /campaigns only returns rows for the authenticated user', async () => {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'c2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_campaigns')).toBe(true);
    expect((body.campaigns as Array<{ id: string }>).map((c) => c.id)).toEqual(['c1']);
  });

  it('GET /lead-lists only returns rows for the authenticated user', async () => {
    state.rowsByTable.li_lead_lists = [
      { id: 'l1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'l2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    state.rowsByTable.li_leads = [];
    const { GET } = await import('@/app/api/tools/li-outreach/lead-lists/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/lead-lists'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_lead_lists')).toBe(true);
    expect((body.lead_lists as Array<{ id: string }>).map((l) => l.id)).toEqual(['l1']);
  });

  it('GET /leads only returns rows for the authenticated user', async () => {
    state.rowsByTable.li_leads = [
      { id: 'L1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'L2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/leads/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/leads'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_leads')).toBe(true);
    expect((body.leads as Array<{ id: string }>).map((l) => l.id)).toEqual(['L1']);
  });

  it('GET /leads/export only includes rows for the authenticated user', async () => {
    state.rowsByTable.li_leads = [
      { id: 'L1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'L2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/leads/export/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/leads/export'));
    const csv = await (res as Response).text();
    expect(ownsUserScope('li_leads')).toBe(true);
    expect(csv).toContain('Mine');
    expect(csv).not.toContain('NotMine');
  });

  it('GET /scraper/tasks only returns rows for the authenticated user', async () => {
    state.rowsByTable.li_tasks = [
      { id: 't1', user_id: AUTH_USER_ID, type: 'search', status: 'pending' },
      { id: 't2', user_id: OTHER_USER_ID, type: 'search', status: 'pending' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/scraper/tasks/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/scraper/tasks'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_tasks')).toBe(true);
    expect((body.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['t1']);
  });

  it('GET /dashboard scopes campaigns and leads by the authenticated user', async () => {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine', status: 'draft', daily_invite_limit: 25, invites_sent_today: 0, lead_list_id: null },
      { id: 'c2', user_id: OTHER_USER_ID, name: 'NotMine', status: 'draft', daily_invite_limit: 25, invites_sent_today: 0, lead_list_id: null },
    ];
    state.rowsByTable.li_leads = [
      { id: 'L1', user_id: AUTH_USER_ID, company: 'Acme', status: 'new' },
      { id: 'L2', user_id: OTHER_USER_ID, company: 'NotMine', status: 'new' },
    ];
    state.rowsByTable.li_campaign_leads = [];
    state.rowsByTable.li_campaign_logs = [];

    const { GET } = await import('@/app/api/tools/li-outreach/dashboard/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/dashboard'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_campaigns')).toBe(true);
    expect(ownsUserScope('li_leads')).toBe(true);
    expect(body.funnel.total).toBe(1);
    const names = (body.campaign_stats as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(['Mine']);
    const companies = (body.by_company as Array<{ company: string }>).map((c) => c.company);
    expect(companies).not.toContain('NotMine');
  });

  it('GET /logs scopes by owned campaigns', async () => {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'c2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    state.rowsByTable.li_campaign_logs = [
      { id: 1, campaign_id: 'c1', level: 'info', message: 'mine-log', created_at: new Date().toISOString() },
      { id: 2, campaign_id: 'c2', level: 'info', message: 'others-log', created_at: new Date().toISOString() },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/logs/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/logs'));
    const body = await (res as Response).json();
    const messages = (body.items as Array<{ message: string }>).map((i) => i.message);
    expect(messages).toContain('mine-log');
    expect(messages).not.toContain('others-log');
  });
});

describe('LI Outreach — owner check on by-id campaign endpoints', () => {
  function seedCampaigns() {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine', status: 'draft', lead_list_id: null },
      { id: 'c2', user_id: OTHER_USER_ID, name: 'NotMine', status: 'draft', lead_list_id: null },
    ];
  }

  it('GET /campaigns/[id] returns 404 for a campaign owned by another user', async () => {
    seedCampaigns();
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns/c2'), { params: Promise.resolve({ id: 'c2' }) });
    expect((res as Response).status).toBe(404);
  });

  it('PUT /campaigns/[id] does not mutate a campaign owned by another user', async () => {
    seedCampaigns();
    const { PUT } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await PUT(
      makeReq('http://x/api/tools/li-outreach/campaigns/c2', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Hacked' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'c2' }) },
    );
    expect([403, 404]).toContain((res as Response).status);
  });

  it('DELETE /campaigns/[id] does not delete a campaign owned by another user', async () => {
    seedCampaigns();
    const { DELETE } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await DELETE(makeReq('http://x/api/tools/li-outreach/campaigns/c2', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect([403, 404]).toContain((res as Response).status);
  });

  it('POST /campaigns/[id]/start refuses a campaign owned by another user', async () => {
    seedCampaigns();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/start/route');
    const res = await POST(makeReq('http://x/api/tools/li-outreach/campaigns/c2/start', { method: 'POST' }), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect([403, 404]).toContain((res as Response).status);
  });

  it('POST /campaigns/[id]/stop refuses a campaign owned by another user', async () => {
    seedCampaigns();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/stop/route');
    const res = await POST(makeReq('http://x/api/tools/li-outreach/campaigns/c2/stop', { method: 'POST' }), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect([403, 404]).toContain((res as Response).status);
  });

  it('GET /campaigns/[id]/stats returns 404 for a campaign owned by another user', async () => {
    seedCampaigns();
    state.rowsByTable.li_campaign_step_stats = [];
    state.rowsByTable.li_campaign_leads = [];
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/stats/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns/c2/stats'), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect((res as Response).status).toBe(404);
  });

  it('GET /campaigns/[id]/logs returns 404 for a campaign owned by another user', async () => {
    seedCampaigns();
    state.rowsByTable.li_campaign_logs = [];
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/logs/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns/c2/logs'), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect((res as Response).status).toBe(404);
  });
});

/**
 * Admin bypass: when checkIsAdmin(authUser) === true the route MUST NOT add
 * `user_id = auth.user.id` to its li_campaigns query. This is the whole point
 * of the "admins manage all LI campaigns" feature — without these tests the
 * isolation suite above passes even if the admin path quietly regresses back
 * to user-scoped behaviour. We assert two complementary signals:
 *   1. cross-user reads return the foreign campaign instead of 404
 *   2. no `eq('user_id', auth.user.id)` filter is recorded against li_campaigns
 *      for the admin's own user_id (admins read globally, not as themselves)
 */
describe('LI Outreach — admin bypass on campaign endpoints', () => {
  function seedCampaigns() {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine', status: 'draft', lead_list_id: null },
      { id: 'c2', user_id: OTHER_USER_ID, name: 'NotMine', status: 'draft', lead_list_id: null },
    ];
  }

  function liCampaignsScopedToAuthUser(): boolean {
    return state.allEqCalls.some(
      (c) => c.table === 'li_campaigns' && c.column === 'user_id' && c.value === AUTH_USER_ID,
    );
  }

  beforeEach(() => {
    adminFlag.value = true;
  });

  it('GET /campaigns returns campaigns from every owner without scoping by user_id', async () => {
    seedCampaigns();
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns'));
    const body = await (res as Response).json();
    expect(liCampaignsScopedToAuthUser()).toBe(false);
    const ids = (body.campaigns as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('GET /campaigns/[id] returns a foreign campaign for an admin', async () => {
    seedCampaigns();
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await GET(
      makeReq('http://x/api/tools/li-outreach/campaigns/c2'),
      { params: Promise.resolve({ id: 'c2' }) },
    );
    expect((res as Response).status).toBe(200);
    const body = await (res as Response).json();
    expect(body.campaign.id).toBe('c2');
    expect(liCampaignsScopedToAuthUser()).toBe(false);
  });

  // The mock builder used in this file treats update/upsert/insert as no-ops
  // (see makeBuilder above) — those flows are covered by dedicated suites
  // (e.g. liOutreachStartCampaignProgress.test.ts). For the admin-bypass
  // surface we only need to assert that the *authz gate* passed: the route
  // returned 200 instead of 404, and never added `user_id = auth.user.id` to
  // its li_campaigns query. That combination is impossible unless the admin
  // branch was taken.

  it('PUT /campaigns/[id] reaches the mutation step for a foreign campaign when admin', async () => {
    seedCampaigns();
    const { PUT } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await PUT(
      makeReq('http://x/api/tools/li-outreach/campaigns/c2', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Renamed by admin' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'c2' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(liCampaignsScopedToAuthUser()).toBe(false);
  });

  it('DELETE /campaigns/[id] reaches the delete step for a foreign campaign when admin', async () => {
    seedCampaigns();
    const { DELETE } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await DELETE(
      makeReq('http://x/api/tools/li-outreach/campaigns/c2', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'c2' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(liCampaignsScopedToAuthUser()).toBe(false);
  });

  it('POST /campaigns/[id]/start passes the owner check on a foreign campaign when admin', async () => {
    seedCampaigns();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/start/route');
    const res = await POST(
      makeReq('http://x/api/tools/li-outreach/campaigns/c2/start', { method: 'POST' }),
      { params: Promise.resolve({ id: 'c2' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(liCampaignsScopedToAuthUser()).toBe(false);
  });

  it('POST /campaigns/[id]/stop passes the owner check on a foreign campaign when admin', async () => {
    seedCampaigns();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/stop/route');
    const res = await POST(
      makeReq('http://x/api/tools/li-outreach/campaigns/c2/stop', { method: 'POST' }),
      { params: Promise.resolve({ id: 'c2' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(liCampaignsScopedToAuthUser()).toBe(false);
  });
});
