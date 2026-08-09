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

describe('GET /api/client/reports/analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requireClientAuthMock.mockResolvedValue({
      auth: { userId: 'client-1', accessRows, isDemo: false },
    });
    loadClientReportAnalyticsMock.mockResolvedValue({ metrics: {}, funnel: {} });
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
      campaignIds: ['campaign-a', 'campaign-b'],
      filters: expect.objectContaining({ score: 'A' }),
    }));
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('keeps the full allowed campaign list when metrics are filtered to one campaign', async () => {
    const response = await GET(request(
      '?preset=last_30_days&score=A&campaign=campaign-a',
    ));

    expect(response.status).toBe(200);
    expect(loadClientReportAnalyticsMock).toHaveBeenCalledWith(expect.objectContaining({
      clientUserId: 'client-1',
      allowedCampaignIds: ['campaign-a', 'campaign-b'],
      campaignIds: ['campaign-a'],
      filters: expect.objectContaining({ campaignId: 'campaign-a' }),
    }));
  });
});
