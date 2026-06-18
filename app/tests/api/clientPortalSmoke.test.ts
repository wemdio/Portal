/** @jest-environment node */

/**
 * Pre-launch smoke harness for the entire `/api/client/*` surface, written
 * before onboarding the first paying client (May 2026).
 *
 * Every route under `/api/client/*` (excluding `/launches/*` per product
 * decision — campaign launches are not in the first-client scope) is
 * exercised against four critical risks:
 *
 *   1. Auth boundary — no Bearer token / non-client role → 4xx (catches a
 *      route that forgot to call requireClientAuth before reading data).
 *   2. RBAC isolation — client A cannot read or mutate client B's resources
 *      via any campaign-scoped or lead-scoped endpoint.
 *   3. Empty new-user state — every list-style endpoint returns a sane,
 *      empty-but-shaped response when the brand-new client has no data.
 *   4. Domain-specific guards — brief save round-trip, hypotheses gate,
 *      reports scope validation.
 *
 * The mock layer mirrors the patterns used in clientProjects.test.ts and
 * liOutreachIsolation.test.ts (chainable supabase builder + jest.mock for
 * external Instantly API + auth helper), so failures here are cheap to
 * diagnose against the same vocabulary.
 */

const AUTH_USER_ID = 'user-A';
const OTHER_USER_ID = 'user-B';

// Resource IDs for RBAC tests. AUTH user is granted access to ALLOWED_CAMPAIGN
// only; FORBIDDEN_CAMPAIGN belongs to a different client.
const ALLOWED_CAMPAIGN = 'cmp-allowed';
const FORBIDDEN_CAMPAIGN = 'cmp-forbidden';

// ── Supabase mock (chainable builder) ────────────────────────────────────────

type EqCall = { table: string; column: string; value: unknown };
type InCall = { table: string; column: string; values: unknown[] };

interface BuilderState {
  table: string;
  eqCalls: EqCall[];
  inCalls: InCall[];
  countMode: 'exact' | null;
  isHead: boolean;
}

const dbState = {
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  allEqCalls: [] as EqCall[],
  upsertCalls: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  insertCalls: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updateCalls: [] as Array<{ table: string; payload: Record<string, unknown>; eqCalls: EqCall[] }>,
};

function resetDbState() {
  dbState.rowsByTable = {};
  dbState.allEqCalls = [];
  dbState.upsertCalls = [];
  dbState.insertCalls = [];
  dbState.updateCalls = [];
}

function makeBuilder(table: string) {
  const local: BuilderState = {
    table,
    eqCalls: [],
    inCalls: [],
    countMode: null,
    isHead: false,
  };

  const finalize = () => {
    let rows = dbState.rowsByTable[table] ?? [];
    for (const eq of local.eqCalls) {
      rows = rows.filter((r) => r[eq.column] === eq.value);
    }
    for (const inFilter of local.inCalls) {
      rows = rows.filter((r) => inFilter.values.includes(r[inFilter.column]));
    }
    return { data: rows, error: null, count: rows.length };
  };

  const builder: Record<string, unknown> = {
    select: (_columns?: string, opts?: { count?: 'exact'; head?: boolean }) => {
      if (opts?.count === 'exact') local.countMode = 'exact';
      if (opts?.head) local.isHead = true;
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    range: async () => finalize(),
    eq: (column: string, value: unknown) => {
      local.eqCalls.push({ table, column, value });
      dbState.allEqCalls.push({ table, column, value });
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      local.inCalls.push({ table, column, values });
      return builder;
    },
    gte: () => builder,
    lte: () => builder,
    or: () => builder,
    not: () => builder,
    update: (payload: Record<string, unknown>) => {
      dbState.updateCalls.push({ table, payload, eqCalls: [...local.eqCalls] });
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      dbState.insertCalls.push({ table, payload });
      // Append to seed for subsequent reads in the same test.
      const arr = Array.isArray(payload) ? payload : [payload];
      dbState.rowsByTable[table] = (dbState.rowsByTable[table] ?? []).concat(
        arr as Array<Record<string, unknown>>,
      );
      return builder;
    },
    upsert: (payload: Record<string, unknown>) => {
      dbState.upsertCalls.push({ table, payload });
      const arr = Array.isArray(payload) ? payload : [payload];
      dbState.rowsByTable[table] = (dbState.rowsByTable[table] ?? []).concat(
        arr as Array<Record<string, unknown>>,
      );
      return builder;
    },
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

const adminFromMock = jest.fn((table: string) => makeBuilder(table));
const instantlyFromMock = jest.fn((table: string) => makeBuilder(table));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => adminFromMock(table) },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: { from: (table: string) => instantlyFromMock(table) },
}));

// ── Auth mock (toggleable per-test) ──────────────────────────────────────────

interface AuthState {
  authed: boolean;
  errorStatus: number;
  errorMessage: string;
  accessRows: Array<{
    resource_type: 'campaign' | 'lead_list';
    resource_id: string;
    instantly_account_id?: string | null;
  }>;
  isDemo: boolean;
}

const authState: AuthState = {
  authed: true,
  errorStatus: 401,
  errorMessage: 'Unauthorized',
  accessRows: [],
  isDemo: false,
};

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => {
      if (!authState.authed) {
        return {
          error: NextResponse.json(
            { error: authState.errorMessage },
            { status: authState.errorStatus },
          ),
        };
      }
      return {
        auth: {
          userId: AUTH_USER_ID,
          accessRows: authState.accessRows,
          isDemo: authState.isDemo,
        },
      };
    }),
  };
});

// ── Cache (just unwrap the callback so all reads run synchronously) ──────────

jest.mock('@/lib/clientCache', () => ({
  cached: jest.fn(<T,>(_key: string, fn: () => Promise<T>) => fn()),
  invalidate: jest.fn(),
}));

// ── Logger noop ──────────────────────────────────────────────────────────────

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

// ── Instantly client mock (HTTP-bound, must NEVER call out in tests) ─────────

const mockGetCampaign = jest.fn();
const mockGetCampaignAnalytics = jest.fn();
const mockGetCampaignAnalyticsSteps = jest.fn();
const mockListEmails = jest.fn();
const mockGetEmail = jest.fn();
const mockReplyToEmail = jest.fn();
const mockForwardEmail = jest.fn();
const mockMarkThreadAsRead = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockActivateCampaign = jest.fn();
const mockPauseCampaign = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
  getCampaignAnalytics: (...args: unknown[]) => mockGetCampaignAnalytics(...args),
  getCampaignAnalyticsSteps: (...args: unknown[]) => mockGetCampaignAnalyticsSteps(...args),
  listEmails: (...args: unknown[]) => mockListEmails(...args),
  getEmail: (...args: unknown[]) => mockGetEmail(...args),
  replyToEmail: (...args: unknown[]) => mockReplyToEmail(...args),
  forwardEmail: (...args: unknown[]) => mockForwardEmail(...args),
  markThreadAsRead: (...args: unknown[]) => mockMarkThreadAsRead(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
  activateCampaign: (...args: unknown[]) => mockActivateCampaign(...args),
  pauseCampaign: (...args: unknown[]) => mockPauseCampaign(...args),
}));

// ── Campaign analytics catalog (DB-backed reads + report builder) ────────────

interface CampaignAnalyticsResult {
  campaigns: Array<Record<string, unknown>>;
  lastSyncedAt: string | null;
}
interface ClientReportResult {
  tableText: string;
  csvText: string;
  rows: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
}

const mockReadCampaignAnalyticsFromDb = jest.fn<
  Promise<CampaignAnalyticsResult>,
  [string[]]
>();
const mockBuildClientReport = jest.fn<ClientReportResult, [unknown[]]>();

jest.mock('@/lib/tools/instantlyCampaignCatalog', () => ({
  readCampaignAnalyticsFromDb: (ids: string[]) => mockReadCampaignAnalyticsFromDb(ids),
  buildClientReport: (campaigns: unknown[]) => mockBuildClientReport(campaigns),
  upsertInstantlyCatalogFromCampaign: jest.fn(async () => {}),
}));

// ── Hypotheses generator (LLM-bound) ─────────────────────────────────────────

interface HypothesesArgs {
  apiKey: string;
  briefText: string;
  signal?: AbortSignal;
  audience?: string;
}

const mockGenerateHypotheses = jest.fn<Promise<string>, [HypothesesArgs]>();

jest.mock('@/lib/projectBriefHypotheses/generateHypotheses', () => ({
  generateLeadSourceHypotheses: (args: HypothesesArgs) => mockGenerateHypotheses(args),
}));

// ── Tariffs ──────────────────────────────────────────────────────────────────

const mockGetClientTariffRow = jest.fn<Promise<Record<string, unknown> | null>, [string]>();
const mockResolveEffectiveLimits = jest.fn<Record<string, number>, [unknown]>();
const mockGetClientStatus = jest.fn<string, [unknown]>();
const mockGetClientTariffUsage = jest.fn<Promise<Record<string, unknown>>, [string]>();

jest.mock('@/lib/tariffs', () => ({
  getClientTariffRow: (userId: string) => mockGetClientTariffRow(userId),
  resolveEffectiveLimits: (row: unknown) => mockResolveEffectiveLimits(row),
  getClientStatus: (row: unknown) => mockGetClientStatus(row),
  getClientTariffUsage: (userId: string) => mockGetClientTariffUsage(userId),
}));

// ── Companies-search regions ─────────────────────────────────────────────────
// regions module is imported by /api/client/companies-search but the route
// only calls it for the regionCodes filter, which we don't exercise here.

// ── Brief lib (real impl is fine — pure functions, no IO) ────────────────────
// Don't mock; we want validateBriefInput / normalizeBriefFields / compileBriefText real.

import { NextRequest } from 'next/server';

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, {
    headers: { authorization: 'Bearer test-token', ...(init?.headers ?? {}) },
    ...init,
  }) as unknown as NextRequest;
}

function makeJsonReq(url: string, method: string, body: unknown): NextRequest {
  return makeReq(url, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetDbState();
  adminFromMock.mockClear();
  instantlyFromMock.mockClear();
  authState.authed = true;
  authState.errorStatus = 401;
  authState.errorMessage = 'Unauthorized';
  authState.accessRows = [];
  authState.isDemo = false;

  mockGetCampaign.mockReset();
  mockGetCampaignAnalytics.mockReset().mockResolvedValue([]);
  mockGetCampaignAnalyticsSteps.mockReset().mockResolvedValue([]);
  mockListEmails.mockReset().mockResolvedValue({ items: [], next_starting_after: null });
  mockGetEmail.mockReset();
  mockReplyToEmail.mockReset().mockResolvedValue({ ok: true });
  mockForwardEmail.mockReset().mockResolvedValue({ ok: true });
  mockMarkThreadAsRead.mockReset().mockResolvedValue({ ok: true });
  mockUpdateCampaign.mockReset();
  mockActivateCampaign.mockReset().mockResolvedValue({ ok: true });
  mockPauseCampaign.mockReset().mockResolvedValue({ ok: true });

  mockReadCampaignAnalyticsFromDb.mockReset().mockResolvedValue({ campaigns: [], lastSyncedAt: null });
  mockBuildClientReport.mockReset().mockReturnValue({
    tableText: 'tbl',
    csvText: 'csv',
    rows: [{ campaign_id: 'cmp', sent: 0 }],
    summary: { totalSent: 0 },
  });

  mockGenerateHypotheses.mockReset().mockResolvedValue('### Гипотеза 1: Test\n- ICP: B2B SaaS\n');

  mockGetClientTariffRow.mockReset().mockResolvedValue(null);
  mockResolveEffectiveLimits.mockReset().mockReturnValue({
    searches_per_month: 10,
    base_constructor_rows_per_run: 10000,
  });
  mockGetClientStatus.mockReset().mockReturnValue('active');
  mockGetClientTariffUsage.mockReset().mockResolvedValue({
    tariff_type: 'standard',
    status: 'active',
    paid_at: null,
    paid_until: null,
    setup_until: null,
    period_start: '2026-05-01T00:00:00.000Z',
    limits: {
      max_contacts: 10000,
      max_rows: 20000,
      max_chains_per_month: 3,
      max_domains: 4,
      max_emails: 16,
    },
    usage: {
      max_contacts: { limit: 10000, used: 0, remaining: 10000 },
      max_rows: { limit: 20000, used: 0, remaining: 20000 },
      max_chains_per_month: { limit: 3, used: 0, remaining: 3 },
      max_domains: { limit: 4, used: 0, remaining: 4 },
      max_emails: { limit: 16, used: 0, remaining: 16 },
    },
  });

  process.env.OPENROUTER_BRIEF_API_KEY = 'test-key';
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Auth boundary — every endpoint MUST refuse a request without a valid
//    client session. We flip authState.authed = false and call each route.
//    The route MUST return the 401 (or 403/500) directly from requireClientAuth
//    instead of leaking through to data reads.
// ────────────────────────────────────────────────────────────────────────────

describe('Client Portal — auth boundary on every endpoint', () => {
  beforeEach(() => {
    authState.authed = false;
    authState.errorStatus = 401;
    authState.errorMessage = 'Unauthorized';
  });

  it('GET /api/client/onboarding/status → 401', async () => {
    const { GET } = await import('@/app/api/client/onboarding/status/route');
    const res = await GET(makeReq('http://x/api/client/onboarding/status'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/brief → 401', async () => {
    const { GET } = await import('@/app/api/client/brief/route');
    const res = await GET(makeReq('http://x/api/client/brief'));
    expect((res as Response).status).toBe(401);
  });

  it('PUT /api/client/brief → 401', async () => {
    const { PUT } = await import('@/app/api/client/brief/route');
    const res = await PUT(
      makeJsonReq('http://x/api/client/brief', 'PUT', { fields: {} }),
    );
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/brief/hypotheses → 401', async () => {
    const { GET } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await GET(makeReq('http://x/api/client/brief/hypotheses'));
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/brief/hypotheses → 401', async () => {
    const { POST } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/brief/hypotheses', 'POST', {}),
    );
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/preset → 401', async () => {
    const { GET } = await import('@/app/api/client/preset/route');
    const res = await GET(makeReq('http://x/api/client/preset'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/tariff → 401', async () => {
    const { GET } = await import('@/app/api/client/tariff/route');
    const res = await GET(makeReq('http://x/api/client/tariff'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/campaigns → 401', async () => {
    const { GET } = await import('@/app/api/client/campaigns/route');
    const res = await GET(makeReq('http://x/api/client/campaigns'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/campaigns/[id] → 401', async () => {
    const { GET } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await GET(makeReq('http://x/api/client/campaigns/c1'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/campaigns/[id]/activate → 401', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/activate/route');
    const res = await POST(makeReq('http://x/api/client/campaigns/c1/activate', { method: 'POST' }), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/campaigns/[id]/pause → 401', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/pause/route');
    const res = await POST(makeReq('http://x/api/client/campaigns/c1/pause', { method: 'POST' }), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/campaigns/[id]/replies → 401', async () => {
    const { GET } = await import('@/app/api/client/campaigns/[id]/replies/route');
    const res = await GET(makeReq('http://x/api/client/campaigns/c1/replies'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/campaigns/[id]/replies/[emailId]/thread → 401', async () => {
    const { GET } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/thread/route');
    const res = await GET(makeReq('http://x/api/client/campaigns/c1/replies/e1/thread'), {
      params: Promise.resolve({ id: 'c1', emailId: 'e1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/campaigns/[id]/replies/[emailId]/reply → 401', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/reply/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/campaigns/c1/replies/e1/reply', 'POST', { body_text: 'Hi' }),
      { params: Promise.resolve({ id: 'c1', emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/campaigns/[id]/replies/[emailId]/forward → 401', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/forward/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/campaigns/c1/replies/e1/forward', 'POST', {
        to_email: 'a@b.com',
      }),
      { params: Promise.resolve({ id: 'c1', emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/leads → 401', async () => {
    const { GET } = await import('@/app/api/client/leads/route');
    const res = await GET(makeReq('http://x/api/client/leads'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/replies → 401', async () => {
    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/campaigns/[id]/replies/[emailId]/mark-lead → 401', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/mark-lead/route');
    const res = await POST(
      makeReq('http://x/api/client/campaigns/c1/replies/e1/mark-lead', { method: 'POST' }),
      { params: Promise.resolve({ id: 'c1', emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/leads/[id]/comments → 401', async () => {
    const { GET } = await import('@/app/api/client/leads/[id]/comments/route');
    const res = await GET(makeReq('http://x/api/client/leads/l1/comments'), {
      params: Promise.resolve({ id: 'l1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/leads/[id]/comments → 401', async () => {
    const { POST } = await import('@/app/api/client/leads/[id]/comments/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/leads/l1/comments', 'POST', { comment: 'hi' }),
      { params: Promise.resolve({ id: 'l1' }) },
    );
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/bases → 401', async () => {
    const { GET } = await import('@/app/api/client/bases/route');
    const res = await GET(makeReq('http://x/api/client/bases'));
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/companies-search → 401', async () => {
    const { POST } = await import('@/app/api/client/companies-search/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/companies-search', 'POST', { countOnly: true }),
    );
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/reports → 401', async () => {
    const { POST } = await import('@/app/api/client/reports/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/reports', 'POST', { campaignIds: [] }),
    );
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/projects → 401', async () => {
    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/client/projects/[id] → 401', async () => {
    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    });
    expect((res as Response).status).toBe(401);
  });

  it('non-client role surfaces as 403 from requireClientAuth', async () => {
    authState.errorStatus = 403;
    authState.errorMessage = 'Forbidden';
    const { GET } = await import('@/app/api/client/brief/route');
    const res = await GET(makeReq('http://x/api/client/brief'));
    expect((res as Response).status).toBe(403);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Empty new-user state — a brand-new client (no brief, no preset, no
//    campaigns assigned, no leads). Every list-style endpoint MUST return a
//    well-formed empty response, not 500 or undefined.
//
//    This is the very first impression a real client gets after manager
//    creates their account: regression here is visible immediately.
// ────────────────────────────────────────────────────────────────────────────

describe('Client Portal — empty new-user state', () => {
  it('GET /onboarding/status returns 6 items, all done=false, next_id=brief', async () => {
    const { GET } = await import('@/app/api/client/onboarding/status/route');
    const res = await GET(makeReq('http://x/api/client/onboarding/status'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<{ id: string; done: boolean }>;
      complete: boolean;
      next_id: string | null;
    };
    expect(body.items).toHaveLength(6);
    expect(body.items.map((i) => i.id)).toEqual([
      'brief', 'preset', 'first_base', 'first_clean', 'first_sequence', 'first_launch',
    ]);
    expect(body.items.every((i) => !i.done)).toBe(true);
    expect(body.complete).toBe(false);
    expect(body.next_id).toBe('brief');
  });

  it('GET /brief returns brief: null and a non-empty compiled_brief_text shape', async () => {
    const { GET } = await import('@/app/api/client/brief/route');
    const res = await GET(makeReq('http://x/api/client/brief'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      brief: unknown;
      compiled_brief_text: string;
    };
    expect(body.brief).toBeNull();
    // compileBriefText returns an empty-or-prelude string but never undefined.
    expect(typeof body.compiled_brief_text).toBe('string');
  });

  it('GET /preset returns preset: null', async () => {
    const { GET } = await import('@/app/api/client/preset/route');
    const res = await GET(makeReq('http://x/api/client/preset'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as { preset: unknown };
    expect(body.preset).toBeNull();
  });

  it('GET /tariff returns standard tariff with default limits', async () => {
    const { GET } = await import('@/app/api/client/tariff/route');
    const res = await GET(makeReq('http://x/api/client/tariff'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      tariff_type: string;
      status: string;
      limits: Record<string, number>;
    };
    expect(body.tariff_type).toBe('standard');
    expect(body.status).toBe('active');
    expect(body.limits).toBeDefined();
  });

  it('GET /campaigns short-circuits to total: 0 when no campaigns granted', async () => {
    const { GET } = await import('@/app/api/client/campaigns/route');
    const res = await GET(makeReq('http://x/api/client/campaigns'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      total: number;
      campaigns: unknown[];
      lastSyncedAt: string | null;
    };
    expect(body.total).toBe(0);
    expect(body.campaigns).toEqual([]);
    expect(body.lastSyncedAt).toBeNull();
    // Crucially, it must NOT have called the catalog read with an empty list:
    // that wastes a DB roundtrip and the function would return [] anyway.
    expect(mockReadCampaignAnalyticsFromDb).not.toHaveBeenCalled();
  });

  it('GET /leads returns items: [] when no forwarded leads and no campaigns granted', async () => {
    const { GET } = await import('@/app/api/client/leads/route');
    const res = await GET(makeReq('http://x/api/client/leads'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(mockListEmails).not.toHaveBeenCalled();
    expect(mockReadCampaignAnalyticsFromDb).not.toHaveBeenCalled();
  });

  it('GET /leads enriches marked leads with Instantly email metadata for reply actions', async () => {
    dbState.rowsByTable.client_forwarded_leads = [
      {
        id: 'lead-1',
        client_user_id: AUTH_USER_ID,
        campaign_id: ALLOWED_CAMPAIGN,
        campaign_name: 'Allowed Campaign',
        lead_email: 'lead@example.com',
        lead_name: 'Lead Person',
        reply_subject: 'Re: Intro',
        reply_body: 'Interested, send details.',
        reply_timestamp: '2026-05-19T10:00:00.000Z',
        created_at: '2026-05-19T10:01:00.000Z',
      },
    ];
    mockListEmails.mockResolvedValueOnce({
      items: [
        {
          id: 'email-1',
          campaign_id: ALLOWED_CAMPAIGN,
          thread_id: 'thread-1',
          lead: 'instantly-lead-1',
          subject: 'Re: Intro',
          body: { text: 'Interested, send details.' },
          from_address_email: 'lead@example.com',
          timestamp_email: '2026-05-19T10:00:00.000Z',
          ue_type: 2,
          is_unread: 0,
          ai_interest_value: 5,
        },
      ],
      next_starting_after: null,
    });

    const { GET } = await import('@/app/api/client/leads/route');
    const res = await GET(makeReq('http://x/api/client/leads'));

    expect((res as Response).status).toBe(200);
    expect(mockListEmails).toHaveBeenCalledWith(expect.objectContaining({
      campaign_id: ALLOWED_CAMPAIGN,
      // Instantly v2 фильтрует по `email_type` (string enum),
      // а не `ue_type` (это поле в ответе).
      email_type: 'received',
      limit: 100,
    }), { accountId: 'main' });
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toMatchObject({
      id: 'lead-1',
      source: 'forwarded_lead',
      email_id: 'email-1',
      lead_id: 'instantly-lead-1',
      thread_id: 'thread-1',
      is_unread: false,
      ai_interest_value: 5,
    });
  });

  it('GET /replies returns items: [] when no campaigns granted', async () => {
    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(mockListEmails).not.toHaveBeenCalled();
  });

  it('GET /replies includes raw campaign replies before they are marked as leads', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    mockReadCampaignAnalyticsFromDb.mockResolvedValueOnce({
      campaigns: [{ id: ALLOWED_CAMPAIGN, name: 'Allowed Campaign' }],
      lastSyncedAt: null,
    });
    mockListEmails.mockResolvedValueOnce({
      items: [
        {
          id: 'email-1',
          campaign_id: ALLOWED_CAMPAIGN,
          thread_id: 'thread-1',
          lead: 'lead-1',
          subject: 'Re: Intro',
          body: { text: 'Interested, send details.' },
          from_address_email: 'lead@example.com',
          from_address_json: [{ address: 'lead@example.com', name: 'Lead Person' }],
          timestamp_email: '2026-05-19T10:00:00.000Z',
          ue_type: 2,
          is_unread: 1,
          ai_interest_value: 5,
        },
      ],
      next_starting_after: null,
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies?limit=30&offset=0'));

    expect((res as Response).status).toBe(200);
    expect(mockListEmails).toHaveBeenCalledWith(expect.objectContaining({
      campaign_id: ALLOWED_CAMPAIGN,
      // См. выше — фильтр Instantly v2 — `email_type`, не `ue_type`.
      email_type: 'received',
      limit: 100,
    }), { accountId: 'main' });
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: `reply:${ALLOWED_CAMPAIGN}:email-1`,
      source: 'reply',
      campaign_id: ALLOWED_CAMPAIGN,
      campaign_name: 'Allowed Campaign',
      lead_email: 'lead@example.com',
      lead_name: 'Lead Person',
      reply_subject: 'Re: Intro',
      reply_body: 'Interested, send details.',
      reply_timestamp: '2026-05-19T10:00:00.000Z',
      email_id: 'email-1',
      thread_id: 'thread-1',
      is_unread: true,
      ai_interest_value: 5,
      is_lead: false,
      lead_entry_id: null,
    });
  });

  it('GET /replies recognizes a marked lead by campaign and email, not timestamp', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    dbState.rowsByTable.client_forwarded_leads = [
      {
        id: 'forwarded-1',
        client_user_id: AUTH_USER_ID,
        campaign_id: ALLOWED_CAMPAIGN,
        lead_email: 'lead@example.com',
        reply_timestamp: '2026-05-19 10:00:00+00',
      },
    ];
    mockReadCampaignAnalyticsFromDb.mockResolvedValueOnce({
      campaigns: [{ id: ALLOWED_CAMPAIGN, name: 'Allowed Campaign' }],
      lastSyncedAt: null,
    });
    mockListEmails.mockResolvedValueOnce({
      items: [
        {
          id: 'email-1',
          campaign_id: ALLOWED_CAMPAIGN,
          thread_id: 'thread-1',
          lead: 'lead-1',
          subject: 'Re: Intro',
          body: { text: 'Interested, send details.' },
          from_address_email: 'lead@example.com',
          timestamp_email: '2026-05-19T10:00:00.000Z',
          ue_type: 2,
          is_unread: 1,
        },
      ],
      next_starting_after: null,
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies?limit=30&offset=0'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toMatchObject({
      is_lead: true,
      lead_entry_id: 'forwarded-1',
      is_unread: false,
      status: 'lead',
    });
  });

  it('GET /replies?search filters locally by subject and sender name (Instantly search is email-only)', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    mockReadCampaignAnalyticsFromDb.mockResolvedValue({
      campaigns: [{ id: ALLOWED_CAMPAIGN, name: 'Allowed Campaign' }],
      lastSyncedAt: null,
    });
    const items = [
      {
        id: 'email-a', campaign_id: ALLOWED_CAMPAIGN, thread_id: 'ta', lead: 'la',
        subject: 'Pricing question', body: { text: 'how much' },
        from_address_email: 'alpha@example.com',
        from_address_json: [{ address: 'alpha@example.com', name: 'Alpha' }],
        timestamp_email: '2026-05-19T10:00:00.000Z', ue_type: 2,
      },
      {
        id: 'email-b', campaign_id: ALLOWED_CAMPAIGN, thread_id: 'tb', lead: 'lb',
        subject: 'Unrelated', body: { text: 'no thanks' },
        from_address_email: 'beta@example.com',
        from_address_json: [{ address: 'beta@example.com', name: 'Beta' }],
        timestamp_email: '2026-05-19T09:00:00.000Z', ue_type: 2,
      },
    ];
    const { GET } = await import('@/app/api/client/replies/route');

    // by SUBJECT word — Instantly's own search would miss this; our local filter catches it.
    mockListEmails.mockResolvedValueOnce({ items, next_starting_after: null });
    let res = await GET(makeReq('http://x/api/client/replies?search=Pricing'));
    expect((res as Response).status).toBe(200);
    let body = (await (res as Response).json()) as { items: Array<{ email_id?: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.email_id).toBe('email-a');
    // Search is NOT forwarded to Instantly (it only matches email) — we filter our side.
    const lastCall = mockListEmails.mock.calls[mockListEmails.mock.calls.length - 1][0];
    expect(lastCall).not.toHaveProperty('search');

    // by SENDER NAME.
    mockListEmails.mockResolvedValueOnce({ items, next_starting_after: null });
    res = await GET(makeReq('http://x/api/client/replies?search=Beta'));
    body = (await (res as Response).json()) as { items: Array<{ email_id?: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.email_id).toBe('email-b');
  });

  it('GET /replies groups a multi-message thread into one conversation row + needs_reply filter', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    mockReadCampaignAnalyticsFromDb.mockResolvedValue({
      campaigns: [{ id: ALLOWED_CAMPAIGN, name: 'Allowed Campaign' }],
      lastSyncedAt: null,
    });
    // Two inbound emails in the SAME thread (lead asked, then a follow-up).
    const items = [
      {
        id: 'email-new', campaign_id: ALLOWED_CAMPAIGN, thread_id: 't1', lead: 'l1',
        subject: 'Re: Re: вопрос', body: { text: 'и ещё уточнение' },
        from_address_email: 'lead@example.com',
        from_address_json: [{ address: 'lead@example.com', name: 'Lead' }],
        timestamp_email: '2026-05-20T10:00:00.000Z', ue_type: 2,
      },
      {
        id: 'email-old', campaign_id: ALLOWED_CAMPAIGN, thread_id: 't1', lead: 'l1',
        subject: 'вопрос', body: { text: 'первый вопрос' },
        from_address_email: 'lead@example.com',
        from_address_json: [{ address: 'lead@example.com', name: 'Lead' }],
        timestamp_email: '2026-05-19T10:00:00.000Z', ue_type: 2,
      },
    ];
    const { GET } = await import('@/app/api/client/replies/route');

    // Two inbound in one thread collapse to ONE conversation row; representative = latest.
    mockListEmails.mockResolvedValueOnce({ items, next_starting_after: null });
    let res = await GET(makeReq('http://x/api/client/replies'));
    expect((res as Response).status).toBe(200);
    let body = (await (res as Response).json()) as {
      items: Array<{ email_id?: string; message_count?: number }>; total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.email_id).toBe('email-new');
    expect(body.items[0]?.message_count).toBe(2);

    // needs_reply: unanswered, non-lead conversation appears.
    mockListEmails.mockResolvedValueOnce({ items, next_starting_after: null });
    res = await GET(makeReq('http://x/api/client/replies?status=needs_reply'));
    body = (await (res as Response).json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(1);

    // answered: nothing answered (empty client_email_replies) → empty.
    mockListEmails.mockResolvedValueOnce({ items, next_starting_after: null });
    res = await GET(makeReq('http://x/api/client/replies?status=answered'));
    body = (await (res as Response).json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(0);
  });

  it('GET /bases returns campaigns: [] when no campaigns granted', async () => {
    const { GET } = await import('@/app/api/client/bases/route');
    const res = await GET(makeReq('http://x/api/client/bases'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as { campaigns: unknown[] };
    expect(body.campaigns).toEqual([]);
  });

  it('GET /projects returns items: [] and total: 0', async () => {
    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Brief flow — save round-trip + hypotheses gate.
//
//    The brief is a hard prerequisite for Hypotheses, ta_scoring in Base
//    Constructor, and (eventually) other AI flows. A regression here breaks
//    the central onboarding promise we made the client.
// ────────────────────────────────────────────────────────────────────────────

describe('Client Portal — brief save/load + hypotheses gate', () => {
  it('PUT /brief with empty body still succeeds (validation allows fully-empty brief)', async () => {
    // Per validateBriefInput: empty-but-shaped brief is ok (free-form save).
    const { PUT } = await import('@/app/api/client/brief/route');

    // Seed empty briefs table; upsert returns the new row.
    dbState.rowsByTable.client_briefs = [
      {
        id: 'br-1',
        client_user_id: AUTH_USER_ID,
        fields: {},
        updated_at: '2026-05-09T00:00:00Z',
        pdf_file_name: null,
        pdf_uploaded_at: null,
      },
    ];

    const res = await PUT(
      makeJsonReq('http://x/api/client/brief', 'PUT', { fields: {} }),
    );
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as { brief: { id: string } };
    expect(body.brief).toBeDefined();
    expect(body.brief.id).toBe('br-1');
  });

  it('PUT /brief rejects invalid JSON body with 400', async () => {
    const { PUT } = await import('@/app/api/client/brief/route');
    const req = new Request('http://x/api/client/brief', {
      method: 'PUT',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: '{not-json',
    }) as unknown as NextRequest;
    const res = await PUT(req);
    expect((res as Response).status).toBe(400);
  });

  it('GET /brief/hypotheses returns null when no brief exists', async () => {
    const { GET } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await GET(makeReq('http://x/api/client/brief/hypotheses'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      lead_source_hypotheses: string | null;
    };
    expect(body.lead_source_hypotheses).toBeNull();
    // GET must NEVER call the LLM.
    expect(mockGenerateHypotheses).not.toHaveBeenCalled();
  });

  it('POST /brief/hypotheses returns 400 when brief is not yet saved', async () => {
    const { POST } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/brief/hypotheses', 'POST', {}),
    );
    expect((res as Response).status).toBe(400);
    const body = (await (res as Response).json()) as { error: string };
    expect(body.error).toMatch(/бриф/i);
    expect(mockGenerateHypotheses).not.toHaveBeenCalled();
  });

  it('POST /brief/hypotheses returns 400 when brief exists but is empty', async () => {
    dbState.rowsByTable.client_briefs = [
      {
        id: 'br-1',
        client_user_id: AUTH_USER_ID,
        fields: {},
        lead_source_hypotheses: null,
        lead_source_hypotheses_generated_at: null,
        lead_source_hypotheses_error: null,
      },
    ];
    const { POST } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/brief/hypotheses', 'POST', {}),
    );
    expect((res as Response).status).toBe(400);
    expect(mockGenerateHypotheses).not.toHaveBeenCalled();
  });

  // Deployment guard "OPENROUTER_BRIEF_API_KEY missing → 500" is captured at
  // module load (top-level `const`), so mid-suite env-var deletion doesn't
  // affect the cached value. That branch is verified manually as part of the
  // pre-launch checklist (env audit step).

  it('POST /brief/hypotheses returns cached value when not regenerating', async () => {
    dbState.rowsByTable.client_briefs = [
      {
        id: 'br-1',
        client_user_id: AUTH_USER_ID,
        fields: {
          company_description: 'Test co',
          product_description: 'Tool',
          target_audience: 'B2B SaaS',
        },
        lead_source_hypotheses: '### Гипотеза 1: cached\n',
        lead_source_hypotheses_generated_at: '2026-05-01T00:00:00Z',
        lead_source_hypotheses_error: null,
      },
    ];
    const { POST } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/brief/hypotheses', 'POST', {}),
    );
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      ok: boolean;
      skipped?: boolean;
      lead_source_hypotheses: string;
    };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.lead_source_hypotheses).toContain('cached');
    // Cached path must NOT call the LLM.
    expect(mockGenerateHypotheses).not.toHaveBeenCalled();
  });

  it('POST /brief/hypotheses?regenerate=1 calls the generator even with cached value', async () => {
    dbState.rowsByTable.client_briefs = [
      {
        id: 'br-1',
        client_user_id: AUTH_USER_ID,
        fields: {
          company_description: 'Test co',
          product_description: 'Tool',
          target_audience: 'B2B SaaS',
        },
        lead_source_hypotheses: '### Гипотеза 1: stale\n',
        lead_source_hypotheses_generated_at: '2026-05-01T00:00:00Z',
        lead_source_hypotheses_error: null,
      },
    ];
    const { POST } = await import('@/app/api/client/brief/hypotheses/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/brief/hypotheses?regenerate=1', 'POST', {}),
    );
    expect((res as Response).status).toBe(200);
    expect(mockGenerateHypotheses).toHaveBeenCalledTimes(1);
    const body = (await (res as Response).json()) as {
      ok: boolean;
      lead_source_hypotheses: string;
      regenerated: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.regenerated).toBe(true);
    expect(body.lead_source_hypotheses).toContain('Гипотеза 1: Test'); // from mock
  });

  it('POST /brief/hypotheses passes audience: client to generator (no «Сигналы»)', async () => {
    dbState.rowsByTable.client_briefs = [
      {
        id: 'br-1',
        client_user_id: AUTH_USER_ID,
        fields: {
          company_description: 'Test co',
          product_description: 'Tool',
          target_audience: 'B2B SaaS',
        },
        lead_source_hypotheses: null,
        lead_source_hypotheses_generated_at: null,
        lead_source_hypotheses_error: null,
      },
    ];
    const { POST } = await import('@/app/api/client/brief/hypotheses/route');
    await POST(
      makeJsonReq('http://x/api/client/brief/hypotheses', 'POST', {}),
    );
    expect(mockGenerateHypotheses).toHaveBeenCalledTimes(1);
    const callArg = mockGenerateHypotheses.mock.calls[0][0] as { audience: string };
    expect(callArg.audience).toBe('client');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. RBAC isolation across clients — every campaign-bound endpoint MUST
//    return 404 when the requested campaign is not in the user's accessRows.
//    This is the highest-impact regression class for the first paid client.
// ────────────────────────────────────────────────────────────────────────────

describe('Client Portal — RBAC isolation across clients', () => {
  beforeEach(() => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
  });

  it('GET /campaigns/[id] of unallowed campaign → 404', async () => {
    const { GET } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}`),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockGetCampaign).not.toHaveBeenCalled();
  });

  it('GET /campaigns/[id] of allowed campaign passes the gate', async () => {
    mockGetCampaign.mockResolvedValueOnce({ id: ALLOWED_CAMPAIGN, name: 'My Campaign' });
    const { GET } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}`),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN }) },
    );
    expect((res as Response).status).toBe(200);
    expect(mockGetCampaign).toHaveBeenCalledWith(ALLOWED_CAMPAIGN, { accountId: 'main' });
  });

  it('GET /campaigns/[id] falls back to launch journal sequence when Instantly returns an empty sequence', async () => {
    dbState.rowsByTable.client_campaign_launches = [
      {
        client_user_id: AUTH_USER_ID,
        instantly_campaign_id: ALLOWED_CAMPAIGN,
        sequence_steps: [
          { subject: 'Hello', body: 'Line 1\nLine 2', wait_days: 0 },
          { subject: '', body: 'Follow-up body', wait_days: 3 },
        ],
      },
    ];
    mockGetCampaign.mockResolvedValueOnce({
      id: ALLOWED_CAMPAIGN,
      name: 'My Campaign',
      sequences: [],
    });

    const { GET } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}`),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN }) },
    );
    expect((res as Response).status).toBe(200);

    const body = await (res as Response).json();
    expect(body.campaign.sequences).toEqual([
      {
        steps: [
          expect.objectContaining({
            variants: [expect.objectContaining({ subject: 'Hello', body: 'Line 1\nLine 2' })],
          }),
          expect.objectContaining({
            variants: [expect.objectContaining({ subject: '', body: 'Follow-up body' })],
          }),
        ],
      },
    ]);
  });

  it('PATCH /campaigns/[id] updates the client launch name and sequence', async () => {
    dbState.rowsByTable.client_campaign_launches = [
      {
        id: 'launch-1',
        client_user_id: AUTH_USER_ID,
        instantly_campaign_id: ALLOWED_CAMPAIGN,
        campaign_name: 'Old name',
        status: 'active',
        sequence_steps: [{ subject: 'Old', body: 'Old body', wait_days: 0 }],
      },
    ];
    mockUpdateCampaign.mockResolvedValueOnce({
      id: ALLOWED_CAMPAIGN,
      name: 'Edited launch',
      status: 1,
      sequences: [],
    });

    const { PATCH } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await PATCH(
      makeJsonReq(`http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}`, 'PATCH', {
        campaign_name: 'Edited launch',
        sequence_steps: [
          { subject: 'Intro', body: 'Line 1\nLine 2', wait_days: 0 },
          {
            subject: '',
            body: 'Follow-up body',
            wait_days: 3,
            variants: [{ subject: '', body: 'Variant B\nBody' }],
          },
        ],
      }),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN }) },
    );
    const body = await (res as Response).json();

    expect((res as Response).status).toBe(200);
    expect(mockUpdateCampaign).toHaveBeenCalledWith(
      ALLOWED_CAMPAIGN,
      expect.objectContaining({
        name: 'Edited launch',
        sequences: [
          {
            steps: [
              expect.objectContaining({
                delay: 3,
                delay_unit: 'days',
                variants: [
                  expect.objectContaining({
                    subject: 'Intro',
                    body: '<div>Line 1</div><div>Line 2</div>',
                  }),
                ],
              }),
              expect.objectContaining({
                delay: 1,
                delay_unit: 'days',
                variants: [
                  expect.objectContaining({ body: '<div>Follow-up body</div>' }),
                  expect.objectContaining({ body: '<div>Variant B</div><div>Body</div>' }),
                ],
              }),
            ],
          },
        ],
      }),
      { accountId: 'main' },
    );
    expect(
      dbState.updateCalls.some(
        (call) =>
          call.table === 'client_campaign_launches' &&
          call.payload.campaign_name === 'Edited launch' &&
          Array.isArray(call.payload.sequence_steps),
      ),
    ).toBe(true);
    expect(
      dbState.allEqCalls.some(
        (eq) => eq.table === 'client_campaign_launches' && eq.column === 'id' && eq.value === 'launch-1',
      ),
    ).toBe(true);
    expect(body.campaign.sequences[0].steps[0].variants[0].body).toBe('<div>Line 1</div><div>Line 2</div>');
  });

  it('PATCH /campaigns/[id] of unallowed campaign -> 404 and does not call Instantly', async () => {
    const { PATCH } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await PATCH(
      makeJsonReq(`http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}`, 'PATCH', {
        campaign_name: 'No access',
        sequence_steps: [{ subject: 'Intro', body: 'Body', wait_days: 0 }],
      }),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN }) },
    );

    expect((res as Response).status).toBe(404);
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
  });

  it('PATCH /campaigns/[id] rejects an empty sequence before Instantly', async () => {
    dbState.rowsByTable.client_campaign_launches = [
      {
        id: 'launch-1',
        client_user_id: AUTH_USER_ID,
        instantly_campaign_id: ALLOWED_CAMPAIGN,
        campaign_name: 'Old name',
        status: 'active',
        sequence_steps: [{ subject: 'Old', body: 'Old body', wait_days: 0 }],
      },
    ];

    const { PATCH } = await import('@/app/api/client/campaigns/[id]/route');
    const res = await PATCH(
      makeJsonReq(`http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}`, 'PATCH', {
        campaign_name: 'Edited launch',
        sequence_steps: [],
      }),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN }) },
    );

    expect((res as Response).status).toBe(400);
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
  });

  it('GET /campaigns/[id]/replies of unallowed campaign → 404', async () => {
    const { GET } = await import('@/app/api/client/campaigns/[id]/replies/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/replies`),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockListEmails).not.toHaveBeenCalled();
  });

  it('GET /campaigns/[id]/replies/[emailId]/thread of unallowed campaign → 404', async () => {
    const { GET } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/thread/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/replies/e1/thread`),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockGetEmail).not.toHaveBeenCalled();
  });

  it('GET /campaigns/[id]/replies/[emailId]/thread marks the Instantly thread as read', async () => {
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: ALLOWED_CAMPAIGN,
      thread_id: 't1',
      lead: 'l1',
      subject: 'Re: Intro',
      body: { text: 'Interested, send details.' },
      from_address_email: 'lead@example.com',
      timestamp_email: '2026-05-19T10:00:00.000Z',
      ue_type: 2,
    });
    mockListEmails.mockResolvedValueOnce({
      items: [
        {
          id: 'sent-1',
          campaign_id: ALLOWED_CAMPAIGN,
          thread_id: 't1',
          lead: 'l1',
          subject: 'Intro',
          body: { text: 'Hi' },
          timestamp_email: '2026-05-18T10:00:00.000Z',
          ue_type: 1,
        },
      ],
      next_starting_after: null,
    });

    const { GET } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/thread/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/thread`),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );

    expect((res as Response).status).toBe(200);
    // Прочитанность ведём ПОШТУЧНО для клиента (client_email_reads), тред в
    // Instantly НЕ трогаем — иначе гасли бы соседние ответы лида.
    expect(mockMarkThreadAsRead).not.toHaveBeenCalled();
    expect(dbState.upsertCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'client_email_reads',
        payload: expect.objectContaining({ client_user_id: AUTH_USER_ID, email_id: 'e1' }),
      }),
    ]));
  });

  it('GET /campaigns/[id]/replies/[emailId]/thread still returns the thread if read-recording fails', async () => {
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: ALLOWED_CAMPAIGN,
      thread_id: 't1',
      lead: 'l1',
      subject: 'Re: Intro',
      body: { text: 'Interested, send details.' },
      from_address_email: 'lead@example.com',
      timestamp_email: '2026-05-19T10:00:00.000Z',
      ue_type: 2,
    });
    const { GET } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/thread/route');
    const res = await GET(
      makeReq(`http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/thread`),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );
    const body = await (res as Response).json();

    // Запись прочитанности — best-effort (try/catch в роуте): тред возвращается
    // в любом случае, общий флаг Instantly не трогается.
    expect((res as Response).status).toBe(200);
    expect(mockMarkThreadAsRead).not.toHaveBeenCalled();
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'e1', direction: 'inbound' }),
    ]));
  });

  it('POST /campaigns/[id]/replies/[emailId]/reply of unallowed campaign → 404', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/reply/route');
    const res = await POST(
      makeJsonReq(
        `http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/replies/e1/reply`,
        'POST',
        { body_text: 'Hi' },
      ),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockReplyToEmail).not.toHaveBeenCalled();
  });

  it('POST /campaigns/[id]/replies/[emailId]/forward of unallowed campaign → 404', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/forward/route');
    const res = await POST(
      makeJsonReq(
        `http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/replies/e1/forward`,
        'POST',
        { to_email: 'a@b.com' },
      ),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockForwardEmail).not.toHaveBeenCalled();
  });

  it('POST /campaigns/[id]/replies/[emailId]/mark-lead of unallowed campaign → 404', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/mark-lead/route');
    const res = await POST(
      makeReq(
        `http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/replies/e1/mark-lead`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockGetEmail).not.toHaveBeenCalled();
  });

  it('reply sends Instantly-required subject with the body', async () => {
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: ALLOWED_CAMPAIGN,
      thread_id: 't1',
      lead: 'l1',
      eaccount: 'sender@me.com',
      subject: 'Intro',
    });
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/reply/route');
    const res = await POST(
      makeJsonReq(
        `http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/reply`,
        'POST',
        { body_text: 'Hi' },
      ),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(mockReplyToEmail).toHaveBeenCalledWith(expect.objectContaining({
      reply_to_uuid: 'e1',
      eaccount: 'sender@me.com',
      subject: 'Re: Intro',
      // body теперь { html, text }: html сохраняет переносы строк (\n -> <br>),
      // text — plain-text fallback. Для 'Hi' переносов нет → html === 'Hi'.
      body: { html: 'Hi', text: 'Hi' },
    }), { accountId: 'main' });
    // Ответ фиксируется персонально: «отвечено» (бейдж в списке) + «прочитано» (статус).
    expect(dbState.upsertCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'client_email_replies', payload: expect.objectContaining({ client_user_id: AUTH_USER_ID, email_id: 'e1' }) }),
      expect.objectContaining({ table: 'client_email_reads', payload: expect.objectContaining({ client_user_id: AUTH_USER_ID, email_id: 'e1' }) }),
    ]));
  });

  it('reply does not double-prefix an existing Re: subject', async () => {
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: ALLOWED_CAMPAIGN,
      thread_id: 't1',
      lead: 'l1',
      eaccount: 'sender@me.com',
      subject: 'Re: Intro',
    });
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/reply/route');
    const res = await POST(
      makeJsonReq(
        `http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/reply`,
        'POST',
        { body_text: 'Hi again' },
      ),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(mockReplyToEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Re: Intro',
      body: { html: 'Hi again', text: 'Hi again' },
    }), { accountId: 'main' });
  });

  it('forward sends Instantly-required body and include_original_body', async () => {
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: ALLOWED_CAMPAIGN,
      thread_id: 't1',
      lead: 'l1',
      eaccount: 'sender@me.com',
      subject: 'Intro',
    });
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/forward/route');
    const res = await POST(
      makeJsonReq(
        `http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/forward`,
        'POST',
        { to_email: 'client@example.com' },
      ),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(mockForwardEmail).toHaveBeenCalledWith(expect.objectContaining({
      reply_to_uuid: 'e1',
      eaccount: 'sender@me.com',
      to_address_email_list: 'client@example.com',
      subject: 'Fwd: Intro',
      body: { text: '' },
      include_original_body: true,
    }), { accountId: 'main' });
  });

  it('mark-lead stores the reply as a client forwarded lead', async () => {
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: ALLOWED_CAMPAIGN,
      thread_id: 't1',
      lead: 'l1',
      subject: 'Re: Intro',
      body: { text: 'Interested, send details.' },
      from_address_email: 'lead@example.com',
      from_address_json: [{ address: 'lead@example.com', name: 'Lead Person' }],
      timestamp_email: '2026-05-19T10:00:00.000Z',
      ue_type: 2,
    });
    mockReadCampaignAnalyticsFromDb.mockResolvedValueOnce({
      campaigns: [{ id: ALLOWED_CAMPAIGN, name: 'Allowed Campaign' }],
      lastSyncedAt: null,
    });
    dbState.rowsByTable.client_campaign_leads = [
      {
        client_user_id: AUTH_USER_ID,
        email: 'lead@example.com',
        first_name: 'Lead',
        last_name: 'Person',
        company_name: 'Acme',
        website: 'acme.com',
        linkedin_url: 'linkedin.com/in/lead',
      },
    ];

    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/mark-lead/route');
    const res = await POST(
      makeReq(
        `http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/mark-lead`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );

    expect((res as Response).status).toBe(201);
    // mark-lead помечает письмо прочитанным ПОШТУЧНО (наша таблица), не тред Instantly.
    expect(mockMarkThreadAsRead).not.toHaveBeenCalled();
    expect(dbState.upsertCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'client_email_reads',
        payload: expect.objectContaining({ client_user_id: AUTH_USER_ID, email_id: 'e1' }),
      }),
    ]));
    expect(dbState.insertCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'client_forwarded_leads',
        payload: expect.objectContaining({
          client_user_id: AUTH_USER_ID,
          forwarded_by: AUTH_USER_ID,
          campaign_id: ALLOWED_CAMPAIGN,
          campaign_name: 'Allowed Campaign',
          lead_email: 'lead@example.com',
          lead_name: 'Lead Person',
          company_name: 'Acme',
          reply_subject: 'Re: Intro',
          reply_body: 'Interested, send details.',
          reply_timestamp: '2026-05-19T10:00:00.000Z',
          status: 'lead',
          forwarded_via: 'portal',
        }),
      }),
    ]));
  });

  it('POST /campaigns/[id]/activate of unallowed campaign → 404', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/activate/route');
    const res = await POST(
      makeReq(`http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/activate`, { method: 'POST' }),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('POST /campaigns/[id]/pause of unallowed campaign → 404', async () => {
    const { POST } = await import('@/app/api/client/campaigns/[id]/pause/route');
    const res = await POST(
      makeReq(`http://x/api/client/campaigns/${FORBIDDEN_CAMPAIGN}/pause`, { method: 'POST' }),
      { params: Promise.resolve({ id: FORBIDDEN_CAMPAIGN }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockPauseCampaign).not.toHaveBeenCalled();
  });

  it('reply rejects emailId belonging to a different campaign (cross-campaign leak)', async () => {
    // Even with allowed campaign access, the emailId itself must belong to that
    // exact campaign. This guards against an attacker substituting a foreign
    // emailId under a known-allowed campaign URL.
    mockGetEmail.mockResolvedValueOnce({
      id: 'e1',
      campaign_id: 'OTHER_CAMPAIGN',
      thread_id: 't1',
      lead: 'l1',
      eaccount: 'sender@me.com',
    });
    const { POST } = await import('@/app/api/client/campaigns/[id]/replies/[emailId]/reply/route');
    const res = await POST(
      makeJsonReq(
        `http://x/api/client/campaigns/${ALLOWED_CAMPAIGN}/replies/e1/reply`,
        'POST',
        { body_text: 'Hi' },
      ),
      { params: Promise.resolve({ id: ALLOWED_CAMPAIGN, emailId: 'e1' }) },
    );
    expect((res as Response).status).toBe(404);
    expect(mockReplyToEmail).not.toHaveBeenCalled();
  });

  it('GET /leads/[id]/comments of foreign lead → 404', async () => {
    dbState.rowsByTable.client_forwarded_leads = [
      { id: 'l-mine', client_user_id: AUTH_USER_ID },
      { id: 'l-foreign', client_user_id: OTHER_USER_ID },
    ];
    const { GET } = await import('@/app/api/client/leads/[id]/comments/route');
    const res = await GET(makeReq('http://x/api/client/leads/l-foreign/comments'), {
      params: Promise.resolve({ id: 'l-foreign' }),
    });
    expect((res as Response).status).toBe(404);
  });

  it('POST /leads/[id]/comments on foreign lead → 404 (no insert performed)', async () => {
    dbState.rowsByTable.client_forwarded_leads = [
      { id: 'l-mine', client_user_id: AUTH_USER_ID },
      { id: 'l-foreign', client_user_id: OTHER_USER_ID },
    ];
    const { POST } = await import('@/app/api/client/leads/[id]/comments/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/leads/l-foreign/comments', 'POST', { comment: 'hi' }),
      { params: Promise.resolve({ id: 'l-foreign' }) },
    );
    expect((res as Response).status).toBe(404);
    expect(dbState.insertCalls.find((c) => c.table === 'client_lead_comments')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Reports scope validation — clients must not be able to silently produce
//    a report containing campaigns they don't own. This is also the only
//    write-style endpoint that takes a list of campaign IDs as input.
// ────────────────────────────────────────────────────────────────────────────

describe('Client Portal — reports scope validation', () => {
  it('POST /reports in demo mode only includes selected campaigns', async () => {
    authState.isDemo = true;
    const { POST } = await import('@/app/api/client/reports/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/reports', 'POST', {
        campaignIds: ['demo-cmp-retail', 'demo-cmp-3pl'],
      }),
    );

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      rows: (string | number)[][];
      summary: { totalCampaigns: number; totalEmailsSent: number; totalReplies: number };
    };
    expect(body.summary.totalCampaigns).toBe(2);
    expect(body.summary.totalEmailsSent).toBe(2960);
    expect(body.summary.totalReplies).toBe(115);
    expect(body.rows.slice(1).map((row) => row[1])).toEqual([
      'Орбита — розничные сети',
      'Орбита — 3PL и фулфилмент',
    ]);
  });

  it('POST /reports with no granted campaigns and no requested IDs → 400', async () => {
    authState.accessRows = [];
    const { POST } = await import('@/app/api/client/reports/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/reports', 'POST', { campaignIds: [] }),
    );
    expect((res as Response).status).toBe(400);
    expect(mockReadCampaignAnalyticsFromDb).not.toHaveBeenCalled();
  });

  it('POST /reports filters out forbidden campaign IDs from the request', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    mockReadCampaignAnalyticsFromDb.mockResolvedValueOnce({
      campaigns: [{ campaign_id: ALLOWED_CAMPAIGN, name: 'Mine', sent: 100 }],
      lastSyncedAt: '2026-05-09T00:00:00Z',
    });
    const { POST } = await import('@/app/api/client/reports/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/reports', 'POST', {
        campaignIds: [ALLOWED_CAMPAIGN, FORBIDDEN_CAMPAIGN],
      }),
    );
    expect((res as Response).status).toBe(200);
    expect(mockReadCampaignAnalyticsFromDb).toHaveBeenCalledTimes(1);
    const calledWith = mockReadCampaignAnalyticsFromDb.mock.calls[0][0];
    expect(calledWith).toEqual([ALLOWED_CAMPAIGN]);
  });

  it('POST /reports with all-forbidden IDs → 400 (nothing to report on)', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    const { POST } = await import('@/app/api/client/reports/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/reports', 'POST', {
        campaignIds: [FORBIDDEN_CAMPAIGN],
      }),
    );
    expect((res as Response).status).toBe(400);
    expect(mockReadCampaignAnalyticsFromDb).not.toHaveBeenCalled();
  });

  it('POST /reports returns 503 when DB has no synced data yet', async () => {
    authState.accessRows = [
      { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
    ];
    mockReadCampaignAnalyticsFromDb.mockResolvedValueOnce({ campaigns: [], lastSyncedAt: null });
    const { POST } = await import('@/app/api/client/reports/route');
    const res = await POST(
      makeJsonReq('http://x/api/client/reports', 'POST', {
        campaignIds: [ALLOWED_CAMPAIGN],
      }),
    );
    expect((res as Response).status).toBe(503);
  });
});
