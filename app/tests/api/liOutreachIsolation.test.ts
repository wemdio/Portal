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
type IsCall = { table: string; column: string; value: unknown };
type InCall = { table: string; column: string; values: unknown[] };

interface ChainState {
  table: string;
  eqCalls: EqCall[];
  isCalls: IsCall[];
  inCalls: InCall[];
}

const state = {
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  allEqCalls: [] as EqCall[],
  allIsCalls: [] as IsCall[],
  allInCalls: [] as InCall[],
};

function resetState() {
  state.rowsByTable = {};
  state.allEqCalls = [];
  state.allIsCalls = [];
  state.allInCalls = [];
}

function makeBuilder(table: string) {
  const local: ChainState = { table, eqCalls: [], isCalls: [], inCalls: [] };

  const finalize = () => {
    let rows = state.rowsByTable[table] ?? [];
    for (const eq of local.eqCalls) {
      rows = rows.filter((r) => r[eq.column] === eq.value);
    }
    for (const isFilter of local.isCalls) {
      rows = rows.filter((r) => r[isFilter.column] === isFilter.value);
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
    is: (column: string, value: unknown) => {
      local.isCalls.push({ table, column, value });
      state.allIsCalls.push({ table, column, value });
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
    // Cross-specialist visibility feature: campaigns/accounts list routes call
    // fetchOwnerNames to label foreign rows. Stub it to an empty map — owner_name
    // resolution itself is not what these isolation tests assert.
    fetchOwnerNames: jest.fn(async () => new Map<string, string>()),
    // Write-path account guard: mirror the real implementation against the
    // seeded li_accounts rows so the foreign-account rejection tests below
    // exercise the same own-vs-foreign decision the route makes.
    userOwnsAccount: jest.fn(async (userId: string, accountId: string) => {
      const rows = state.rowsByTable.li_accounts ?? [];
      return rows.some((r) => r.id === accountId && r.user_id === userId);
    }),
  };
});

// Scraper routes import scraperLogic for the fire-and-forget run; stub it so
// importing the route is hermetic (we only assert the authz gate, never run a
// real scrape).
jest.mock('@/lib/liOutreach/scraperLogic', () => ({
  scrapeLinkedInSearch: jest.fn(async () => {}),
  scrapePostReactions: jest.fn(async () => {}),
}));

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

afterEach(() => {
  jest.useRealTimers();
});

describe('LI Outreach — user_id isolation on list endpoints', () => {
  // Cross-specialist visibility (2026-05): the accounts/campaigns LIST endpoints
  // intentionally return ALL specialists' rows so everyone sees every launch in
  // one window. This is read-only — mutation/by-id endpoints still enforce
  // ownership (covered by the "owner check" describe block below). A foreign
  // account's proxy_url is redacted server-side so credentials don't leak.
  it('GET /accounts returns all specialists’ accounts, redacting others’ proxy', async () => {
    state.rowsByTable.li_accounts = [
      { id: 'a1', user_id: AUTH_USER_ID, name: 'Mine', proxy_url: 'http://mine:secret@h:1' },
      { id: 'a2', user_id: OTHER_USER_ID, name: 'NotMine', proxy_url: 'http://other:secret@h:2' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/accounts/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/accounts'));
    const body = await (res as Response).json();
    const accounts = body.accounts as Array<{ id: string; proxy_url: string | null }>;
    expect(accounts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    // No user_id scoping on the list anymore.
    expect(ownsUserScope('li_accounts')).toBe(false);
    // Own proxy preserved, the other specialist's proxy redacted to null.
    expect(accounts.find((a) => a.id === 'a1')!.proxy_url).toBe('http://mine:secret@h:1');
    expect(accounts.find((a) => a.id === 'a2')!.proxy_url).toBeNull();
  });

  it('GET /campaigns returns all specialists’ campaigns (cross-user visibility)', async () => {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine' },
      { id: 'c2', user_id: OTHER_USER_ID, name: 'NotMine' },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns'));
    const body = await (res as Response).json();
    expect((body.campaigns as Array<{ id: string }>).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    // No user_id scoping on the list anymore.
    expect(ownsUserScope('li_campaigns')).toBe(false);
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

  it('GET /leads can filter orphan leads without leaving user scope', async () => {
    state.rowsByTable.li_leads = [
      { id: 'L1', user_id: AUTH_USER_ID, name: 'Listed', lead_list_id: 'list-1' },
      { id: 'L2', user_id: AUTH_USER_ID, name: 'Unlisted', lead_list_id: null },
      { id: 'L3', user_id: OTHER_USER_ID, name: 'OtherUnlisted', lead_list_id: null },
    ];
    const { GET } = await import('@/app/api/tools/li-outreach/leads/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/leads?lead_list_id=__none'));
    const body = await (res as Response).json();
    expect(ownsUserScope('li_leads')).toBe(true);
    expect(state.allIsCalls).toContainEqual({ table: 'li_leads', column: 'lead_list_id', value: null });
    expect((body.leads as Array<{ id: string }>).map((l) => l.id)).toEqual(['L2']);
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

  it('GET /dashboard returns zero invites_sent_today when last_invite_date is stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    state.rowsByTable.li_campaigns = [
      {
        id: 'stale',
        user_id: AUTH_USER_ID,
        name: 'Stale counter',
        status: 'running',
        daily_invite_limit: 30,
        invites_sent_today: 30,
        last_invite_date: '2026-05-26T00:00:00.000Z',
        lead_list_id: null,
      },
      {
        id: 'fresh',
        user_id: AUTH_USER_ID,
        name: 'Fresh counter',
        status: 'running',
        daily_invite_limit: 30,
        invites_sent_today: 7,
        last_invite_date: '2026-05-28T00:00:00.000Z',
        lead_list_id: null,
      },
    ];
    state.rowsByTable.li_leads = [];
    state.rowsByTable.li_campaign_leads = [];
    state.rowsByTable.li_campaign_logs = [];

    const { GET } = await import('@/app/api/tools/li-outreach/dashboard/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/dashboard'));
    const body = await (res as Response).json();
    const statsByName = Object.fromEntries(
      (body.campaign_stats as Array<{ name: string; invites_sent_today: number }>).map((c) => [
        c.name,
        c,
      ]),
    );

    expect(statsByName['Stale counter'].invites_sent_today).toBe(0);
    expect(statsByName['Fresh counter'].invites_sent_today).toBe(7);
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

  // Cross-specialist read (view-only): GET by-id / logs / stats now return a
  // foreign campaign so any specialist can inspect how another's launch works.
  // The mutation tests below (PUT/DELETE/start/stop) still assert isolation.
  it('GET /campaigns/[id] returns a foreign campaign read-only', async () => {
    seedCampaigns();
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns/c2'), { params: Promise.resolve({ id: 'c2' }) });
    expect((res as Response).status).toBe(200);
    const body = await (res as Response).json();
    expect(body.campaign.id).toBe('c2');
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

  it('GET /campaigns/[id]/stats returns a foreign campaign read-only', async () => {
    seedCampaigns();
    state.rowsByTable.li_campaign_step_stats = [];
    state.rowsByTable.li_campaign_leads = [];
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/stats/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns/c2/stats'), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect((res as Response).status).toBe(200);
  });

  it('GET /campaigns/[id]/logs returns a foreign campaign read-only', async () => {
    seedCampaigns();
    state.rowsByTable.li_campaign_logs = [];
    const { GET } = await import('@/app/api/tools/li-outreach/campaigns/[id]/logs/route');
    const res = await GET(makeReq('http://x/api/tools/li-outreach/campaigns/c2/logs'), {
      params: Promise.resolve({ id: 'c2' }),
    });
    expect((res as Response).status).toBe(200);
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

/**
 * Account-ownership guard on WRITE paths. The accounts list is visible
 * cross-specialist, so the campaign/scraper account dropdowns can surface
 * another specialist's account. These routes must refuse to *use* a foreign
 * account (403) — otherwise A could run invites/scrapes through B's LinkedIn
 * account (quota theft / actions attributed to B / ban risk on B's account).
 */
describe('LI Outreach — account ownership guard on write paths', () => {
  function seedAccounts() {
    state.rowsByTable.li_accounts = [
      { id: 'a1', user_id: AUTH_USER_ID, name: 'Mine', is_active: true },
      { id: 'a2', user_id: OTHER_USER_ID, name: 'NotMine', is_active: true },
    ];
  }

  it('POST /campaigns rejects attaching another specialist’s account (403)', async () => {
    seedAccounts();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/route');
    const res = await POST(
      makeReq('http://x/api/tools/li-outreach/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name: 'New', account_id: 'a2' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect((res as Response).status).toBe(403);
  });

  it('PUT /campaigns/[id] rejects reassigning to another specialist’s account (403)', async () => {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine', status: 'draft', lead_list_id: null },
    ];
    seedAccounts();
    const { PUT } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await PUT(
      makeReq('http://x/api/tools/li-outreach/campaigns/c1', {
        method: 'PUT',
        body: JSON.stringify({ account_id: 'a2' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect((res as Response).status).toBe(403);
  });

  it('PUT /campaigns/[id] allows reassigning to your OWN account', async () => {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, name: 'Mine', status: 'draft', lead_list_id: null },
    ];
    seedAccounts();
    const { PUT } = await import('@/app/api/tools/li-outreach/campaigns/[id]/route');
    const res = await PUT(
      makeReq('http://x/api/tools/li-outreach/campaigns/c1', {
        method: 'PUT',
        body: JSON.stringify({ account_id: 'a1' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect((res as Response).status).toBe(200);
  });

  it('POST /scraper/search rejects another specialist’s account (403)', async () => {
    seedAccounts();
    const { POST } = await import('@/app/api/tools/li-outreach/scraper/search/route');
    const res = await POST(
      makeReq('http://x/api/tools/li-outreach/scraper/search', {
        method: 'POST',
        body: JSON.stringify({ search_url: 'https://www.linkedin.com/search/x', account_id: 'a2' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect((res as Response).status).toBe(403);
  });

  it('POST /scraper/reactions rejects another specialist’s account (403)', async () => {
    seedAccounts();
    const { POST } = await import('@/app/api/tools/li-outreach/scraper/reactions/route');
    const res = await POST(
      makeReq('http://x/api/tools/li-outreach/scraper/reactions', {
        method: 'POST',
        body: JSON.stringify({ post_url: 'https://www.linkedin.com/posts/x', account_id: 'a2' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect((res as Response).status).toBe(403);
  });
});
