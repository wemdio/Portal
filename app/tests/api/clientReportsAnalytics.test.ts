/** @jest-environment node */

import { NextRequest } from 'next/server';

const requireClientAuthMock = jest.fn();
const loadClientReportAnalyticsMock = jest.fn();

jest.mock('@/lib/clientApiHelper', () => ({
  requireClientAuth: (...args: unknown[]) => requireClientAuthMock(...args),
  jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
}));

jest.mock('@/lib/clientReports/analytics', () => ({
  loadClientReportAnalytics: (...args: unknown[]) => loadClientReportAnalyticsMock(...args),
}));

import { GET } from '@/app/api/client/reports/analytics/route';

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/client/reports/analytics${query}`);
}

const accessRows = [
  { resource_type: 'campaign', resource_id: 'campaign-a' },
  { resource_type: 'campaign', resource_id: 'campaign-b' },
];

const pipelineOnlyPayload = {
  campaigns: [
    { id: 'campaign-a', name: 'Campaign A' },
    { id: 'campaign-b', name: 'Campaign B' },
  ],
  filters: {
    preset: 'last_30_days',
    from: '2026-07-01',
    to: '2026-07-31',
    score: 'all',
    campaignId: null,
  },
  funnel: {
    scoredCompanies: 100,
    workingScoreCompanies: 30,
    emailFoundCompanies: 20,
    validatedEmails: 18,
    submittedContacts: 10,
    confirmedContacts: 7,
    byCampaign: [],
  },
  freshness: { pipelineAt: '2026-07-31T11:00:00.000Z' },
  legacyNotice: null,
  qualityNotices: [],
};

describe('GET /api/client/reports/analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requireClientAuthMock.mockResolvedValue({
      auth: { userId: 'client-1', accessRows, isDemo: false },
    });
    loadClientReportAnalyticsMock.mockResolvedValue(pipelineOnlyPayload);
  });

  it('forwards authentication errors unchanged', async () => {
    requireClientAuthMock.mockResolvedValue({ error: Response.json({ error: 'unauthorized' }, { status: 401 }) });
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it('rejects an unknown campaign instead of falling back to all campaigns', async () => {
    const response = await GET(request('?preset=last_30_days&campaign=foreign'));
    expect(response.status).toBe(403);
    expect(loadClientReportAnalyticsMock).not.toHaveBeenCalled();
  });

  it('scopes analytics to every allowed campaign when no campaign is requested', async () => {
    const response = await GET(request('?preset=last_30_days&score=A'));

    expect(response.status).toBe(200);
    expect(loadClientReportAnalyticsMock).toHaveBeenCalledWith(expect.objectContaining({
      clientUserId: 'client-1',
      allowedCampaignIds: ['campaign-a', 'campaign-b'],
      filters: expect.objectContaining({ score: 'A' }),
    }));
    expect(loadClientReportAnalyticsMock.mock.calls[0]?.[0]).not.toHaveProperty('campaignIds');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('keeps the full allowed campaign list when the pipeline is filtered to one campaign', async () => {
    const response = await GET(request(
      '?preset=last_30_days&score=A&campaign=campaign-a',
    ));

    expect(response.status).toBe(200);
    expect(loadClientReportAnalyticsMock).toHaveBeenCalledWith(expect.objectContaining({
      clientUserId: 'client-1',
      allowedCampaignIds: ['campaign-a', 'campaign-b'],
      filters: expect.objectContaining({ campaignId: 'campaign-a' }),
    }));
    expect(loadClientReportAnalyticsMock.mock.calls[0]?.[0]).not.toHaveProperty('campaignIds');
  });

  it('returns the pipeline-only service payload unchanged', async () => {
    const response = await GET(request('?preset=last_30_days'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(pipelineOnlyPayload);
    expect(body).not.toHaveProperty('metrics');
    expect(body.freshness).not.toHaveProperty('analyticsAt');
  });

  it('does not expose database errors to the client', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    loadClientReportAnalyticsMock.mockRejectedValueOnce(
      new Error('canceling statement due to statement timeout on secret relation'),
    );

    const response = await GET(request('?preset=last_30_days'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'Воронка базы временно недоступна. Повторите попытку позже.',
    });
    expect(JSON.stringify(body)).not.toMatch(/statement timeout|secret relation/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('uses the same pipeline-only schema for demo clients', async () => {
    requireClientAuthMock.mockResolvedValueOnce({
      auth: { userId: 'demo-client', accessRows: [], isDemo: true },
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('metrics');
    expect(body.freshness).toEqual({ pipelineAt: null });
    expect(body.freshness).not.toHaveProperty('analyticsAt');
    expect(body.funnel).toEqual({
      scoredCompanies: 0,
      workingScoreCompanies: 0,
      emailFoundCompanies: 0,
      validatedEmails: 0,
      submittedContacts: 0,
      confirmedContacts: 0,
      byCampaign: [],
    });
    expect(loadClientReportAnalyticsMock).not.toHaveBeenCalled();
  });
});
