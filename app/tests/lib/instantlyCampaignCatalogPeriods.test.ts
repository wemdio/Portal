/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '../helpers/mockSupabase';

let mockInstantlyDb: MockSupabaseClient | null;
let mockMainDb: MockSupabaseClient | null;
const originalFetch = globalThis.fetch;

jest.mock('server-only', () => ({}), { virtual: true });

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/instantly/client', () => ({
  getCampaignAnalytics: jest.fn(),
}));

jest.mock('@/lib/tools/autoReportBuilder', () => ({
  iterateInstantlyCampaignPages: jest.fn(),
}));

describe('autoMatchCampaignsToProjects period links', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    delete process.env.INSTANTLY_AI_MATCH_THROTTLE_MS;

    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-1', client: 'Acme' },
        ],
        project_periods: [
          {
            id: 'period-1',
            project_id: 'project-1',
            status: 'closed',
            period_start: '2026-04-01',
            period_end: '2026-04-30',
            created_at: '2026-04-01T00:00:00Z',
          },
          {
            id: 'period-2',
            project_id: 'project-1',
            status: 'active',
            period_start: '2026-05-01',
            period_end: null,
            // Кнопку «Новый период» нажали 2026-05-01 — это граница привязки.
            created_at: '2026-05-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-new',
            name: 'Acme May outreach',
            timestamp_created: '2026-05-03T10:00:00Z',
            new_leads_contacted_count: 0,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('links a newly matched campaign only to the active project period', async () => {
    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(1);
    expect(mockInstantlyDb!.upserts).toContainEqual(
      expect.objectContaining({
        table: 'project_period_instantly_campaigns',
        onConflict: 'period_id,campaign_id',
        rows: [
          expect.objectContaining({
            project_id: 'project-1',
            period_id: 'period-2',
            campaign_id: 'campaign-new',
            baseline_contacts: 0,
          }),
        ],
      }),
    );
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toContainEqual(
      expect.objectContaining({
        project_id: 'project-1',
        period_id: 'period-2',
        campaign_id: 'campaign-new',
      }),
    );
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).not.toContainEqual(
      expect.objectContaining({ period_id: 'period-1' }),
    );
  });

  it('does NOT attach a campaign created before the period was opened (button-press boundary)', async () => {
    // Период открыт 2026-05-01 (created_at). Кампания создана 2026-04-15 —
    // ДО открытия, поэтому это «старая» кампания и привязываться к активному
    // периоду не должна, даже если её имя матчится с клиентом. Бэкдейтинг
    // period_start тут роли не играет.
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-old',
            name: 'Acme legacy outreach',
            timestamp_created: '2026-04-15T10:00:00Z',
            new_leads_contacted_count: 500,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toHaveLength(0);
  });

  it('writes AI auto matches to the active period instead of the legacy project link', async () => {
    process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY = 'test-key';
    process.env.INSTANTLY_AI_MATCH_THROTTLE_MS = '0';
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                matches: [
                  {
                    campaign_id: 'campaign-ai',
                    confidence: 0.95,
                    reason: 'Core brand appears in the campaign name.',
                  },
                ],
              }),
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-ai', client: 'Acme Group' },
        ],
        project_periods: [
          {
            id: 'period-ai',
            project_id: 'project-ai',
            status: 'active',
            period_start: '2026-05-01',
            period_end: null,
            created_at: '2026-05-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-ai',
            name: 'Acme pilot outreach',
            timestamp_created: '2026-05-03T10:00:00Z',
            new_leads_contacted_count: 0,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toContainEqual(
      expect.objectContaining({
        project_id: 'project-ai',
        period_id: 'period-ai',
        campaign_id: 'campaign-ai',
        match_source: 'auto-ai',
        baseline_contacts: 0,
        match_confidence: 0.95,
      }),
    );
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toHaveLength(0);
  });
});
