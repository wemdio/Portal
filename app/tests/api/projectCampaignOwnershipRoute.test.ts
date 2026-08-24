/** @jest-environment node */

import type { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { campaignOwnershipRpcHandlers } from '@/../tests/helpers/mockCampaignOwnershipRpc';

let mockMainDb: MockSupabaseClient | null = null;
let mockInstantlyDb: MockSupabaseClient | null = null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

function makeCampaignReq(campaignId: string): NextRequest {
  return new Request('http://x/api/projects/project-target/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ campaign_id: campaignId }),
  }) as unknown as NextRequest;
}

describe('POST /api/projects/[id]/campaigns ownership', () => {
  beforeEach(() => {
    jest.resetModules();
    mockMainDb = createMockSupabase({
      tables: {
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });
  });

  it('returns 409 instead of assigning a campaign owned by another project', async () => {
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          {
            id: 'existing-link',
            project_id: 'project-existing',
            period_id: 'period-existing',
            campaign_id: 'campaign-shared',
            match_source: 'auto-text',
          },
        ],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/campaigns/route');
    const res = await POST(
      makeCampaignReq('campaign-shared'),
      { params: Promise.resolve({ id: 'project-target' }) },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/another project/i) }),
    );
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(1);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')[0]).toEqual(
      expect.objectContaining({ project_id: 'project-existing' }),
    );
  });

  it('allows the same project to assign its campaign to a new active period', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        project_periods: [
          {
            id: 'period-current',
            project_id: 'project-target',
            status: 'active',
            period_start: '2026-08-01',
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-renewal',
            timestamp_created: '2026-08-02T00:00:00Z',
            new_leads_contacted_count: 0,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          {
            id: 'old-period-link',
            project_id: 'project-target',
            period_id: 'period-old',
            campaign_id: 'campaign-renewal',
            match_source: 'manual',
          },
        ],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/campaigns/route');
    const res = await POST(
      makeCampaignReq('campaign-renewal'),
      { params: Promise.resolve({ id: 'project-target' }) },
    );

    expect(res.status).toBe(200);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ period_id: 'period-old', project_id: 'project-target' }),
        expect.objectContaining({ period_id: 'period-current', project_id: 'project-target' }),
      ]),
    );
  });

  it('returns 500 without claiming when the active-period read fails', async () => {
    mockMainDb = createMockSupabase({
      errorSelects: {
        project_periods: {
          columnsInclude: 'id, period_start, created_at',
          message: 'active period lookup unavailable',
        },
      },
      tables: {
        project_periods: [
          {
            id: 'period-current',
            project_id: 'project-target',
            status: 'active',
            period_start: '2026-08-01',
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/campaigns/route');
    const res = await POST(
      makeCampaignReq('campaign-read-error'),
      { params: Promise.resolve({ id: 'project-target' }) },
    );

    expect(res.status).toBe(500);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
  });

  it('returns 500 without claiming when the active-period baseline read fails', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        project_periods: [
          {
            id: 'period-current',
            project_id: 'project-target',
            status: 'active',
            period_start: '2026-08-01',
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      errorSelects: {
        instantly_campaign_catalog: {
          columnsInclude: 'id, timestamp_created, new_leads_contacted_count',
          message: 'campaign baseline unavailable',
        },
      },
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-baseline-error',
            timestamp_created: '2026-07-01T00:00:00Z',
            new_leads_contacted_count: 420,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/campaigns/route');
    const res = await POST(
      makeCampaignReq('campaign-baseline-error'),
      { params: Promise.resolve({ id: 'project-target' }) },
    );

    expect(res.status).toBe(500);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
  });
});
