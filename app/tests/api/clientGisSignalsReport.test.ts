/** @jest-environment node */

/**
 * Tests for GET /api/client/gis-signals/report — периодная отчётность
 * дашборда «2GIS + сигналы» (воронка+дельты, срез 8 сигналов, грейды,
 * недельный отчёт, остаток пула).
 *
 * Гейт — как у основного роута: один клиент из конфига, чужим 404.
 * Невалидные period/week → 400. Сбой отчётных запросов → 500. Сбой
 * Instantly daily по кампании → window: null, роут не падает. Оценка пула
 * null (таймаут 2GIS) → poolEstimate/remaining/weeksLeft: null.
 */

jest.mock('server-only', () => ({}));

const AUTH_USER_ID = 'user-gis-client';
const OTHER_USER_ID = 'user-someone-else';
const CAMPAIGN_EDU = 'camp-edu';
const CLIENT_ACCOUNT_OPTS = { accountId: 'client-acc-1' };

// Фиксируем «сейчас»: среда 2026-08-12 18:00 МСК.
const NOW = new Date('2026-08-12T15:00:00.000Z');

const state = {
  user: null as { id: string } | null,
  configRow: null as Record<string, unknown> | null,
  segmentRows: [] as Array<Record<string, unknown>>,
  segmentsError: null as { message: string } | null,
};

function resetState() {
  state.user = { id: AUTH_USER_ID };
  state.configRow = { id: 1, client_user_id: AUTH_USER_ID };
  state.segmentRows = [
    {
      key: 'edu', label: 'Онлайн-образование', instantly_campaign_id: CAMPAIGN_EDU,
      rubric_groups: [{ category: 'Образование', includedSubcategories: ['Языковые школы'] }],
      enabled: true, priority: 10,
    },
    {
      key: 'legal', label: 'Юридические услуги', instantly_campaign_id: null,
      rubric_groups: [{ category: 'Юр/фин', includedSubcategories: ['Юридические услуги'] }],
      enabled: true, priority: 20,
    },
    {
      key: 'remont', label: 'Ремонт / мебель', instantly_campaign_id: null,
      rubric_groups: [], enabled: false, priority: 30,
    },
  ];
  state.segmentsError = null;
}

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    maybeSingle: async () => {
      if (table === 'gis_signal_pipeline_config') {
        return { data: state.configRow, error: null };
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

const getPeriodFunnelMock = jest.fn();
const getPeriodCompanyStatsMock = jest.fn();
const getAppendBatchTotalsMock = jest.fn();
const getPoolProcessedCountsMock = jest.fn();

jest.mock('@/lib/gisSignalOutreach/reportQueries', () => ({
  getPeriodFunnel: (...args: unknown[]) => getPeriodFunnelMock(...args),
  getPeriodCompanyStats: (...args: unknown[]) => getPeriodCompanyStatsMock(...args),
  getAppendBatchTotals: (...args: unknown[]) => getAppendBatchTotalsMock(...args),
  getPoolProcessedCounts: (...args: unknown[]) => getPoolProcessedCountsMock(...args),
}));

const loadConfigMock = jest.fn();

jest.mock('@/lib/gisSignalOutreach/config', () => ({
  loadGisSignalConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

jest.mock('@/lib/gisSignalOutreach/segments', () => ({
  // Зеркало реальной чистой функции квот (деление по весам + остаток по
  // наибольшей дробной части). Мокаем весь модуль ради его тяжёлых импортов
  // (датасет 2GIS), поэтому логика повторена здесь — менять синхронно.
  computeSegmentQuotas: (dailyLimit: number, segmentsOrWeights: number | number[]) => {
    const weights =
      typeof segmentsOrWeights === 'number'
        ? Array.from({ length: Math.max(0, Math.floor(segmentsOrWeights)) }, () => 1)
        : segmentsOrWeights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
    if (weights.length === 0) return [];
    const limit = Number.isFinite(dailyLimit) && dailyLimit > 0 ? Math.floor(dailyLimit) : 0;
    if (limit === 0) return weights.map(() => 0);
    const weightSum = weights.reduce((sum: number, w: number) => sum + w, 0);
    const effective = weightSum > 0 ? weights : weights.map(() => 1);
    const effectiveSum = weightSum > 0 ? weightSum : effective.length;
    const exact = effective.map((w: number) => (limit * w) / effectiveSum);
    const quotas = exact.map((x: number) => Math.floor(x));
    let rest = limit - quotas.reduce((sum: number, q: number) => sum + q, 0);
    const byFraction = exact
      .map((x: number, i: number) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; rest > 0; k = (k + 1) % byFraction.length) {
      quotas[byFraction[k].i] += 1;
      rest -= 1;
    }
    return quotas;
  },
}));

const estimateSegmentPoolsMock = jest.fn();

jest.mock('@/lib/gisSignalOutreach/poolEstimates', () => ({
  estimateSegmentPools: (...args: unknown[]) => estimateSegmentPoolsMock(...args),
}));

const resolveOptsMock = jest.fn();

jest.mock('@/lib/instantly/clientAccountOptions', () => ({
  resolveClientInstantlyRequestOptions: (...args: unknown[]) => resolveOptsMock(...args),
}));

const getCampaignAnalyticsDailyMock = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
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

const ROUTE_URL = 'http://x/api/client/gis-signals/report';

interface ReportBody {
  period: { preset: string; from: string | null; to: string | null; days: number | null };
  funnel: unknown[];
  funnelPrev: unknown[] | null;
  stats: Array<{ segmentKey: string; gradeA: number; medianScore: number | null }>;
  weekly: {
    weekId: string;
    weekStart: string;
    weekEnd: string;
    appended: Array<{
      segmentKey: string;
      label: string;
      campaignId: string;
      requested: number;
      accepted: number;
      skipped: number;
    }>;
    campaignWindow: Array<{
      segmentKey: string;
      label: string;
      window: { emailsSent: number; openCount: number; replyCount: number } | null;
    }>;
  };
  pool: Array<{
    segmentKey: string;
    processed: number;
    poolEstimate: number | null;
    remaining: number | null;
    weeklyConsumption: number | null;
    weeksLeft: number | null;
  }>;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  resetState();
  getUserMock.mockReset();
  getUserMock.mockImplementation(async () => ({ data: { user: state.user } }));

  getPeriodFunnelMock.mockReset();
  getPeriodFunnelMock.mockResolvedValue([
    { runDate: 'period', segmentKey: 'edu', pulled: 10, signalsOk: 6, onlineOk: 5, bcIn: 4, validContacts: 3, appended: 2 },
  ]);
  getPeriodCompanyStatsMock.mockReset();
  getPeriodCompanyStatsMock.mockResolvedValue([
    {
      segmentKey: 'legal', companies: 5,
      signalHits: { signal_legal_relevance: 4 }, scored: 5,
      gradeA: 2, gradeB: 2, gradeC: 1, rejected: 0, medianScore: 60,
    },
  ]);
  getAppendBatchTotalsMock.mockReset();
  getAppendBatchTotalsMock.mockResolvedValue([
    { campaignId: CAMPAIGN_EDU, requested: 10, accepted: 8, skipped: 2 },
  ]);
  getPoolProcessedCountsMock.mockReset();
  getPoolProcessedCountsMock.mockResolvedValue([
    { segmentKey: 'edu', seenCount: 5, archiveCount: 100, processed: 102 },
  ]);
  estimateSegmentPoolsMock.mockReset();
  estimateSegmentPoolsMock.mockResolvedValue(new Map([['edu', 1000], ['legal', null], ['remont', null]]));
  loadConfigMock.mockReset();
  loadConfigMock.mockResolvedValue({ id: 1, daily_limit: 100 });
  resolveOptsMock.mockReset();
  resolveOptsMock.mockResolvedValue(CLIENT_ACCOUNT_OPTS);
  getCampaignAnalyticsDailyMock.mockReset();
  getCampaignAnalyticsDailyMock.mockResolvedValue([
    { date: '2026-08-10', emails_sent_count: 5, open_count: 2, reply_count: 1 },
  ]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('GET /api/client/gis-signals/report — gating и валидация', () => {
  it('returns 401 without an Authorization token', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(ROUTE_URL, false));
    expect((res as Response).status).toBe(401);
  });

  it('returns 404 (not 403) when the user is not the configured client', async () => {
    state.user = { id: OTHER_USER_ID };
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(404);
  });

  it('returns 400 on unsupported period preset', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(`${ROUTE_URL}?period=year`));
    expect((res as Response).status).toBe(400);
  });

  it('returns 400 on custom period without from/to', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(`${ROUTE_URL}?period=custom&from=2026-08-01`));
    expect((res as Response).status).toBe(400);
  });

  it('returns 400 on unsupported week', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(`${ROUTE_URL}?week=last`));
    expect((res as Response).status).toBe(400);
  });
});

describe('GET /api/client/gis-signals/report — сборка ответа', () => {
  it('200: периодная воронка с дельтой-рангом, stats, weekly, pool', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as ReportBody;

    // Период по умолчанию — 7d (2026-08-06..2026-08-12 МСК).
    expect(body.period).toEqual({ preset: '7d', from: '2026-08-06', to: '2026-08-12', days: 7 });

    // Воронка периода запрошена с UTC-границами московских полуночей.
    const ranges = getPeriodFunnelMock.mock.calls.map((c) => c[0]);
    expect(ranges[0]).toEqual({
      fromUtc: new Date('2026-08-05T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-12T21:00:00.000Z'),
    });
    // Второй вызов — предыдущие 7 дней (дельта).
    expect(ranges[1]).toEqual({
      fromUtc: new Date('2026-07-29T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-05T21:00:00.000Z'),
    });
    expect(body.funnel).toHaveLength(1);
    expect(body.funnelPrev).toHaveLength(1);
    expect(body.stats[0]).toMatchObject({ segmentKey: 'legal', gradeA: 2, medianScore: 60 });

    // Недельный отчёт: текущая неделя пн 2026-08-10 — вс 2026-08-16.
    expect(body.weekly.weekId).toBe('current');
    expect(body.weekly.weekStart).toBe('2026-08-10');
    expect(body.weekly.weekEnd).toBe('2026-08-16');
    expect(body.weekly.appended).toEqual([
      { segmentKey: 'edu', label: 'Онлайн-образование', campaignId: CAMPAIGN_EDU, requested: 10, accepted: 8, skipped: 2 },
    ]);
    // Заливки запрошены за неделю, только по кампаниям сегментов и этому клиенту.
    expect(getAppendBatchTotalsMock).toHaveBeenCalledWith(
      { fromUtc: new Date('2026-08-09T21:00:00.000Z'), toExclusiveUtc: new Date('2026-08-16T21:00:00.000Z') },
      [CAMPAIGN_EDU],
      AUTH_USER_ID,
    );
    // Окно кампаний недели — daily-эндпоинт с датами недели (МСК).
    expect(getCampaignAnalyticsDailyMock).toHaveBeenCalledWith(
      { campaign_id: CAMPAIGN_EDU, start_date: '2026-08-10', end_date: '2026-08-16' },
      CLIENT_ACCOUNT_OPTS,
    );
    expect(body.weekly.campaignWindow).toEqual([
      { segmentKey: 'edu', label: 'Онлайн-образование', window: { emailsSent: 5, openCount: 2, replyCount: 1 } },
    ]);

    // Остаток пула: edu — оценка 1000, обработано 102 → остаток 898,
    // потребление 50/день × 5 = 250/нед → 3.6 недели. legal без оценки → null'ы.
    expect(getPoolProcessedCountsMock).toHaveBeenCalledWith(['edu', 'legal', 'remont']);
    expect(body.pool).toEqual([
      { segmentKey: 'edu', processed: 102, poolEstimate: 1000, remaining: 898, weeklyConsumption: 250, weeksLeft: 3.6 },
      { segmentKey: 'legal', processed: 0, poolEstimate: null, remaining: null, weeklyConsumption: 250, weeksLeft: null },
      { segmentKey: 'remont', processed: 0, poolEstimate: null, remaining: null, weeklyConsumption: null, weeksLeft: null },
    ]);
  });

  it('period=all → funnelPrev: null (дельт нет), границы не передаются', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(`${ROUTE_URL}?period=all`));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as ReportBody;
    expect(body.period).toEqual({ preset: 'all', from: null, to: null, days: null });
    expect(body.funnelPrev).toBeNull();
    expect(getPeriodFunnelMock.mock.calls[0][0]).toEqual({ fromUtc: null, toExclusiveUtc: null });
  });

  it('period=custom проксирует свои даты (МСК) в UTC-границы', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(`${ROUTE_URL}?period=custom&from=2026-08-01&to=2026-08-10`));
    expect((res as Response).status).toBe(200);
    expect(getPeriodFunnelMock.mock.calls[0][0]).toEqual({
      fromUtc: new Date('2026-07-31T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-10T21:00:00.000Z'),
    });
  });

  it('week=previous → окно кампаний и заливки за прошлую неделю', async () => {
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(`${ROUTE_URL}?week=previous`));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as ReportBody;
    expect(body.weekly.weekId).toBe('previous');
    expect(body.weekly.weekStart).toBe('2026-08-03');
    expect(body.weekly.weekEnd).toBe('2026-08-09');
    expect(getCampaignAnalyticsDailyMock).toHaveBeenCalledWith(
      { campaign_id: CAMPAIGN_EDU, start_date: '2026-08-03', end_date: '2026-08-09' },
      CLIENT_ACCOUNT_OPTS,
    );
    expect(getAppendBatchTotalsMock).toHaveBeenCalledWith(
      { fromUtc: new Date('2026-08-02T21:00:00.000Z'), toExclusiveUtc: new Date('2026-08-09T21:00:00.000Z') },
      [CAMPAIGN_EDU],
      AUTH_USER_ID,
    );
  });

  it('сбой Instantly daily → window: null, роут не падает', async () => {
    getCampaignAnalyticsDailyMock.mockRejectedValue(new Error('Instantly API 500'));
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as ReportBody;
    expect(body.weekly.campaignWindow[0].window).toBeNull();
  });

  it('сбой отчётного запроса → 500, а не тихий 200', async () => {
    getPeriodCompanyStatsMock.mockRejectedValue(new Error('PostgREST down'));
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(500);
  });

  it('сбой таблицы сегментов → 500', async () => {
    state.segmentsError = { message: 'relation gone' };
    const { GET } = await import('@/app/api/client/gis-signals/report/route');
    const res = await GET(makeReq(ROUTE_URL));
    expect((res as Response).status).toBe(500);
  });
});
