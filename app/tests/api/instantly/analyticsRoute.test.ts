/** @jest-environment node */

/**
 * GET /api/instantly/analytics?type=campaigns
 *
 * Background (May 2026):
 *   The analyzer page calls this endpoint with `source=api` to bypass the
 *   `instantly_campaign_catalog` cache and fetch live data from Instantly.
 *   Instantly's bulk `/campaigns/analytics` endpoint started returning sporadic
 *   500 ("Unable to count leads") on a workspace with ~1700 campaigns.
 *   The previous behavior surfaced that 500 to the analyzer UI as a hard error.
 *
 * The fix: graceful fallback API → DB. The route MUST keep the body shape
 * (an array of analytics items) for backward compatibility, but it now sets
 * three response headers so the UI can show staleness:
 *
 *   X-Data-Source:     'db' | 'api' | 'db-fallback'
 *   X-Data-Freshness:  ISO timestamp of max(analytics_synced_at) (db modes)
 *   X-Api-Error:       Instantly error message (db-fallback only)
 *
 * Behavior matrix:
 *
 *  source=api   Instantly  DB      → result
 *  ─────────────────────────────────────────────────
 *  yes          200        n/a     → API body, X-Data-Source: api
 *  yes          500/timeout OK     → DB body, X-Data-Source: db-fallback,
 *                                    X-Data-Freshness, X-Api-Error
 *  yes          500        miss    → 5xx error (no good source)
 *  no           n/a        OK      → DB body, X-Data-Source: db,
 *                                    X-Data-Freshness
 *  no           200        miss    → API body, X-Data-Source: api
 *
 * Regression #1: with source=api, when Instantly throws InstantlyApiError(500,
 * "Unable to count leads"), the route MUST NOT propagate that as a 500 to the
 * client. It must serve cached rows with X-Data-Source: db-fallback.
 *
 * Regression #2: when reading from DB (db / db-fallback), X-Data-Freshness
 * MUST equal max(analytics_synced_at) across all returned rows so the UI can
 * decide whether to show a "stale data" banner.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { CampaignAnalytics } from '@/lib/instantly/types';

const AUTH_USER = { id: 'user-A', email: 'a@example.com' };

let mockDb: MockSupabaseClient | null = createMockSupabase();
const getCampaignAnalytics = jest.fn();

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockDb;
  },
}));

jest.mock('@/lib/instantly/client', () => ({
  __esModule: true,
  getCampaignAnalytics: (...args: unknown[]) => getCampaignAnalytics(...args),
  InstantlyApiError: class InstantlyApiError extends Error {
    status: number;
    body?: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = 'InstantlyApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

jest.mock('@/lib/instantly/apiRouteHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  type Handler = (
    req: unknown,
    user: typeof AUTH_USER,
    params?: Record<string, string>,
  ) => Promise<unknown>;
  return {
    dynamic: 'force-dynamic',
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    withAuth: (handler: Handler) => async (req: unknown) => {
      try {
        return await handler(req, AUTH_USER);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Instantly API error';
        const status = (err as { status?: number })?.status ?? 500;
        return NextResponse.json({ error: message }, { status });
      }
    },
  };
});

import { NextRequest } from 'next/server';

class FakeInstantlyApiError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'InstantlyApiError';
    this.status = status;
    this.body = body;
  }
}

function makeReq(qs: string): NextRequest {
  return new Request(`http://x/api/instantly/analytics?${qs}`, {
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  jest.resetModules();
  getCampaignAnalytics.mockReset();
  mockDb = createMockSupabase();
});

async function seedCatalog(
  rows: Array<Partial<{
    id: string;
    name: string;
    emails_sent_count: number;
    open_count: number;
    reply_count: number;
    bounced_count: number;
    new_leads_contacted_count: number;
    unsubscribed_count: number;
    leads_count: number;
    analytics_synced_at: string;
  }>>,
): Promise<void> {
  // The helper's builder is thenable; awaiting flushes the insert into the
  // in-memory table store.
  await mockDb!.from('instantly_campaign_catalog').insert(rows);
}

async function callRoute(qs: string): Promise<Response> {
  const mod = await import('@/app/api/instantly/analytics/route');
  return mod.GET(makeReq(qs)) as unknown as Promise<Response>;
}

describe('GET /api/instantly/analytics?type=campaigns — source=api with Instantly OK', () => {
  it('returns body from Instantly API and sets X-Data-Source: api', async () => {
    getCampaignAnalytics.mockResolvedValueOnce([
      { campaign_id: 'c1', leads_count: 100, emails_sent_count: 50 },
      { campaign_id: 'c2', leads_count: 200, emails_sent_count: 75 },
    ] as CampaignAnalytics[]);

    const res = await callRoute('type=campaigns&source=api');
    const body = (await res.json()) as Array<{ campaign_id: string }>;

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Data-Source')).toBe('api');
    expect(res.headers.get('X-Api-Error')).toBeNull();
    expect(body.map((r) => r.campaign_id)).toEqual(['c1', 'c2']);
    expect(getCampaignAnalytics).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/instantly/analytics?type=campaigns — source=api with Instantly failing', () => {
  it('falls back to DB cache on 500 "Unable to count leads" instead of returning 500', async () => {
    await seedCatalog([
      {
        id: 'c1',
        name: 'Camp 1',
        leads_count: 111,
        emails_sent_count: 50,
        open_count: 10,
        reply_count: 2,
        bounced_count: 1,
        new_leads_contacted_count: 49,
        unsubscribed_count: 0,
        analytics_synced_at: '2026-04-13T06:14:19.301217+00:00',
      },
      {
        id: 'c2',
        name: 'Camp 2',
        leads_count: 222,
        emails_sent_count: 75,
        open_count: 20,
        reply_count: 3,
        bounced_count: 0,
        new_leads_contacted_count: 75,
        unsubscribed_count: 1,
        analytics_synced_at: '2026-04-13T06:14:19.301217+00:00',
      },
    ]);

    getCampaignAnalytics.mockRejectedValueOnce(
      new FakeInstantlyApiError(
        'Instantly API 500: {"statusCode":500,"error":"Internal Server Error","message":"Unable to count leads"}',
        500,
      ),
    );

    const res = await callRoute('type=campaigns&source=api');
    const body = (await res.json()) as Array<{ campaign_id: string; leads_count: number }>;

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Data-Source')).toBe('db-fallback');
    expect(res.headers.get('X-Data-Freshness')).toBe('2026-04-13T06:14:19.301217+00:00');
    expect(res.headers.get('X-Api-Error')).toContain('Unable to count leads');
    expect(body.map((r) => r.campaign_id).sort()).toEqual(['c1', 'c2']);
    expect(body.find((r) => r.campaign_id === 'c1')!.leads_count).toBe(111);
  });

  it('returns 5xx when both Instantly AND DB fail (no usable source)', async () => {
    mockDb = null;

    getCampaignAnalytics.mockRejectedValueOnce(
      new FakeInstantlyApiError('Instantly API 500: Unable to count leads', 500),
    );

    const res = await callRoute('type=campaigns&source=api');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });
});

describe('GET /api/instantly/analytics?type=campaigns — default (DB-first)', () => {
  it('returns DB rows with X-Data-Source: db and X-Data-Freshness from max(analytics_synced_at)', async () => {
    await seedCatalog([
      {
        id: 'c1',
        name: 'Camp 1',
        leads_count: 111,
        emails_sent_count: 50,
        open_count: 10,
        reply_count: 2,
        bounced_count: 1,
        new_leads_contacted_count: 49,
        unsubscribed_count: 0,
        analytics_synced_at: '2026-04-10T00:00:00+00:00',
      },
      {
        id: 'c2',
        name: 'Camp 2',
        leads_count: 222,
        emails_sent_count: 75,
        open_count: 20,
        reply_count: 3,
        bounced_count: 0,
        new_leads_contacted_count: 75,
        unsubscribed_count: 1,
        analytics_synced_at: '2026-05-05T12:00:00+00:00',
      },
    ]);

    const res = await callRoute('type=campaigns');
    const body = (await res.json()) as Array<{ campaign_id: string }>;

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Data-Source')).toBe('db');
    expect(res.headers.get('X-Data-Freshness')).toBe('2026-05-05T12:00:00+00:00');
    expect(res.headers.get('X-Api-Error')).toBeNull();
    expect(body.map((r) => r.campaign_id).sort()).toEqual(['c1', 'c2']);
    expect(getCampaignAnalytics).not.toHaveBeenCalled();
  });

  it('falls back to Instantly API when DB is misconfigured / unavailable', async () => {
    mockDb = null;
    getCampaignAnalytics.mockResolvedValueOnce([
      { campaign_id: 'c1', leads_count: 111 },
    ] as CampaignAnalytics[]);

    const res = await callRoute('type=campaigns');
    const body = (await res.json()) as Array<{ campaign_id: string }>;

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Data-Source')).toBe('api');
    expect(body.map((r) => r.campaign_id)).toEqual(['c1']);
  });
});

describe('GET /api/instantly/analytics?type=campaigns&campaign_id=X', () => {
  it('filters DB rows by campaign_id', async () => {
    await seedCatalog([
      {
        id: 'c1',
        name: 'Camp 1',
        leads_count: 111,
        analytics_synced_at: '2026-05-05T12:00:00+00:00',
      },
      {
        id: 'c2',
        name: 'Camp 2',
        leads_count: 222,
        analytics_synced_at: '2026-05-05T12:00:00+00:00',
      },
    ]);

    const res = await callRoute('type=campaigns&campaign_id=c1');
    const body = (await res.json()) as Array<{ campaign_id: string }>;

    expect(res.status).toBe(200);
    expect(body.map((r) => r.campaign_id)).toEqual(['c1']);
  });
});
