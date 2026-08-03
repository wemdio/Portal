/** @jest-environment node */

/**
 * Tests for GET /api/client/gis-signals — гейтинг дашборда «2GIS + сигналы».
 *
 * Роут виден ровно одному клиенту: user.id должен совпасть с
 * gis_signal_pipeline_config.client_user_id (синглтон id=1). Всем остальным —
 * 404 (не 403), чтобы не раскрывать существование роута. Без токена — 401.
 *
 * Успешный ответ: segments / weeklyFunnel / totalFunnel / signalSlice /
 * campaigns. Сбой Instantly по кампании → analytics: null, роут не падает.
 */

jest.mock('server-only', () => ({}));

const AUTH_USER_ID = 'user-gis-client';
const OTHER_USER_ID = 'user-someone-else';
const CAMPAIGN_ID = 'camp-1';

const state = {
  user: null as { id: string } | null,
  configRow: null as Record<string, unknown> | null,
  configError: null as { message: string } | null,
  segmentRows: [] as Array<Record<string, unknown>>,
  segmentsError: null as { message: string } | null,
};

function resetState() {
  state.user = { id: AUTH_USER_ID };
  state.configRow = { id: 1, client_user_id: AUTH_USER_ID };
  state.configError = null;
  state.segmentRows = [
    { key: 'stomatologii', label: 'Стоматологии', instantly_campaign_id: CAMPAIGN_ID },
    { key: 'shkoly', label: 'Школы', instantly_campaign_id: null },
  ];
  state.segmentsError = null;
}

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => {
      if (table === 'gis_signal_pipeline_config') {
        return { data: state.configRow, error: state.configError };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (table === 'gis_signal_segments') {
        resolve({ data: state.segmentRows, error: state.segmentsError });
      } else {
        resolve({ data: [], error: null });
      }
    },
  };
  return builder;
}

const getUserMock = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (authHeader: string | null) => {
    if (!authHeader) return null;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  },
  createAuthedSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}));

jest.mock('@/lib/gisSignalOutreach/reportQueries', () => ({
  getWeeklyFunnel: jest.fn(async () => [
    { runDate: '2026-08-03', segmentKey: 'stomatologii', pulled: 10, signalsOk: 6, bcIn: 4, validContacts: 3, appended: 2 },
  ]),
  getTotalFunnel: jest.fn(async () => [
    { runDate: 'all', segmentKey: 'stomatologii', pulled: 100, signalsOk: 60, bcIn: 40, validContacts: 30, appended: 20 },
  ]),
  getSignalSlice: jest.fn(async () => [
    { segmentKey: 'stomatologii', signalKey: 'signal_general_phone', companies: 5 },
  ]),
}));

const getCampaignAnalyticsMock = jest.fn();
const getCampaignAnalyticsDailyMock = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  getCampaignAnalytics: (...args: unknown[]) => getCampaignAnalyticsMock(...args),
  getCampaignAnalyticsDaily: (...args: unknown[]) => getCampaignAnalyticsDailyMock(...args),
}));

import { NextRequest } from 'next/server';

function makeReq(url: string, withToken = true): NextRequest {
  const req = new Request(
    url,
    withToken ? { headers: { authorization: 'Bearer test-token' } } : undefined,
  );
  return req as unknown as NextRequest;
}

const ROUTE_URL = 'http://x/api/client/gis-signals';

beforeEach(() => {
  resetState();
  getUserMock.mockReset();
  getUserMock.mockImplementation(async () => ({ data: { user: state.user } }));
  getCampaignAnalyticsMock.mockReset();
  getCampaignAnalyticsMock.mockResolvedValue([
    { campaign_id: CAMPAIGN_ID, emails_sent_count: 50, open_count: 20, reply_count: 3 },
  ]);
  getCampaignAnalyticsDailyMock.mockReset();
  getCampaignAnalyticsDailyMock.mockResolvedValue([
    { date: '2026-08-01', emails_sent_count: 5, open_count: 2, reply_count: 1 },
  ]);
});

describe('GET /api/client/gis-signals — gating', () => {
  it('returns 401 without an Authorization token', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL, false));
    expect((res as Response).status).toBe(401);
  });

  it('returns 401 when the token resolves to no user', async () => {
    state.user = null;
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(401);
  });

  it('returns 404 when the pipeline config row does not exist', async () => {
    state.configRow = null;
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(404);
  });

  it('returns 404 (not 403) when the user is not the configured client', async () => {
    state.user = { id: OTHER_USER_ID };
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(404);
  });

  it('returns 200 with funnel/slice/segments/campaigns for the configured client', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL));
    const body = (await (res as Response).json()) as {
      segments: Array<{ key: string; label: string; hasCampaign: boolean }>;
      weeklyFunnel: unknown[];
      totalFunnel: unknown[];
      signalSlice: unknown[];
      campaigns: Array<{
        segmentKey: string;
        label: string;
        analytics: {
          allTime: { emails_sent_count?: number } | null;
          last7Days: { emailsSent: number } | null;
        } | null;
      }>;
    };

    expect((res as Response).status).toBe(200);
    expect(body.segments).toEqual([
      { key: 'stomatologii', label: 'Стоматологии', hasCampaign: true },
      { key: 'shkoly', label: 'Школы', hasCampaign: false },
    ]);
    expect(body.weeklyFunnel).toHaveLength(1);
    expect(body.totalFunnel).toHaveLength(1);
    expect(body.signalSlice).toHaveLength(1);
    // Кампания только у сегмента с instantly_campaign_id.
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].segmentKey).toBe('stomatologii');
    expect(getCampaignAnalyticsMock).toHaveBeenCalledWith({ campaign_id: CAMPAIGN_ID });
    expect(body.campaigns[0].analytics?.allTime?.emails_sent_count).toBe(50);
    expect(body.campaigns[0].analytics?.last7Days?.emailsSent).toBe(5);
  });

  it('keeps 200 with analytics: null when Instantly fails for a campaign', async () => {
    getCampaignAnalyticsMock.mockRejectedValue(new Error('Instantly API 500'));
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL));
    const body = (await (res as Response).json()) as {
      campaigns: Array<{ segmentKey: string; analytics: unknown }>;
    };

    expect((res as Response).status).toBe(200);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].analytics).toBeNull();
  });

  it('keeps allTime when only the daily (last-7-days) call fails', async () => {
    getCampaignAnalyticsDailyMock.mockRejectedValue(new Error('daily endpoint down'));
    const { GET } = await import('@/app/api/client/gis-signals/route');
    const res = await GET(makeReq(ROUTE_URL));
    const body = (await (res as Response).json()) as {
      campaigns: Array<{
        analytics: {
          allTime: { emails_sent_count?: number } | null;
          last7Days: unknown;
        } | null;
      }>;
    };

    expect((res as Response).status).toBe(200);
    expect(body.campaigns[0].analytics?.allTime?.emails_sent_count).toBe(50);
    expect(body.campaigns[0].analytics?.last7Days).toBeNull();
  });
});
