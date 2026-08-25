/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '../helpers/mockSupabase';
import {
  campaignOwnershipRpcHandlers,
  mockClaimProjectInstantlyCampaign,
} from '../helpers/mockCampaignOwnershipRpc';

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
      rpcHandlers: campaignOwnershipRpcHandlers,
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
      rpcHandlers: campaignOwnershipRpcHandlers,
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
      rpcHandlers: campaignOwnershipRpcHandlers,
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

  it('isolates an AI ownership conflict so another campaign is still linked', async () => {
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
                    campaign_id: 'campaign-conflict',
                    confidence: 0.95,
                    reason: 'Acme spelling match.',
                  },
                  {
                    campaign_id: 'campaign-independent',
                    confidence: 0.95,
                    reason: 'Acme spelling match.',
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
        projects: [{ id: 'project-ai', client: 'Acme Group' }],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        claim_project_instantly_campaign: async (params, db) => {
          if (params.p_campaign_id === 'campaign-conflict') {
            return {
              data: {
                status: 'conflict',
                conflicting_project_ids: ['project-racing-owner'],
              },
            };
          }
          return mockClaimProjectInstantlyCampaign(params, db);
        },
      },
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-conflict',
            name: 'Acme pilot conflict',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 0,
          },
          {
            id: 'campaign-independent',
            name: 'Acme pilot independent',
            timestamp_created: '2026-08-20T10:00:00Z',
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
    expect(mockInstantlyDb!.rpcCalls.filter(
      (call) => call.fn === 'claim_project_instantly_campaign',
    )).toHaveLength(2);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({
        project_id: 'project-ai',
        campaign_id: 'campaign-independent',
        match_source: 'auto-ai',
      }),
    ]);
  });

  it('replaces a stale automatic owner when one unambiguous text match points to another project', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-stale', client: 'Polza' },
          { id: 'project-current', client: 'ENagency' },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-enagency',
            name: 'ENagency direct hypothesis 001',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 300,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'stale-link',
            project_id: 'project-stale',
            campaign_id: 'campaign-enagency',
            match_source: 'auto-text',
          },
        ],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(1);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({
        project_id: 'project-current',
        campaign_id: 'campaign-enagency',
        match_source: 'auto-text',
      }),
    ]);
  });

  it('cleans an exact ENagency cross-table duplicate, archives Polza, and preserves manual target metadata', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-polza', client: 'Polza' },
          { id: 'project-enagency', client: 'ENagency' },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-karan',
            name: 'ENagency direct hypothesis 001',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 300,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'target-link',
            project_id: 'project-enagency',
            campaign_id: 'campaign-karan',
            match_source: 'manual',
            match_reason: 'specialist confirmed',
          },
        ],
        project_period_instantly_campaigns: [
          {
            id: 'foreign-link',
            project_id: 'project-polza',
            period_id: 'period-polza',
            campaign_id: 'campaign-karan',
            match_source: 'auto-text',
            match_reason: 'stale catalog match',
            baseline_contacts: 257,
          },
        ],
        project_instantly_campaigns_denylist: [],
        campaign_project_ownership_archive: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(1);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({
        id: 'target-link',
        project_id: 'project-enagency',
        campaign_id: 'campaign-karan',
        match_source: 'manual',
        match_reason: 'specialist confirmed',
      }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('campaign_project_ownership_archive')).toContainEqual(
      expect.objectContaining({
        original_link_id: 'foreign-link',
        source_table: 'project_period_instantly_campaigns',
        project_id: 'project-polza',
        baseline_contacts: 257,
        replacement_project_id: 'project-enagency',
        archive_reason: 'replaced_stale_automatic_owner',
      }),
    );
  });

  it('never replaces an owner from a short common substring match', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-existing', client: 'Polza' },
          { id: 'project-short-name', client: 'AI' },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-short-substring',
            name: 'RAIL logistics outreach',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 10,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'existing-link',
            project_id: 'project-existing',
            campaign_id: 'campaign-short-substring',
            match_source: 'auto-text',
          },
        ],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-existing' }),
    ]);
  });

  it('does not replace a manual owner with an automatic text match', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-manual', client: 'Polza' },
          { id: 'project-candidate', client: 'ENagency' },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-manual',
            name: 'ENagency pricing outreach',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 10,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'manual-link',
            project_id: 'project-manual',
            campaign_id: 'campaign-manual',
            match_source: 'manual',
          },
        ],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({
        project_id: 'project-manual',
        campaign_id: 'campaign-manual',
        match_source: 'manual',
      }),
    ]);
  });

  it('does not make an RPC claim for an unchanged correct automatic owner', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{ id: 'project-current', client: 'ENagency' }],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-current',
            name: 'ENagency pricing outreach',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 10,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'correct-link',
            project_id: 'project-current',
            campaign_id: 'campaign-current',
            match_source: 'auto-text',
          },
        ],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
  });

  it('fails closed before any claim when the active-period read fails', async () => {
    mockMainDb = createMockSupabase({
      errorSelects: {
        project_periods: {
          columnsInclude: 'id, project_id, created_at',
          message: 'active period read unavailable',
        },
      },
      tables: {
        projects: mockMainDb!.getRows('projects'),
        project_periods: mockMainDb!.getRows('project_periods'),
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
  });

  it.each([
    [
      'legacy ownership',
      'project_instantly_campaigns',
      'project_id, campaign_id, match_source',
    ],
    [
      'period ownership',
      'project_period_instantly_campaigns',
      'project_id, period_id, campaign_id, match_source',
    ],
    [
      'denylist',
      'project_instantly_campaigns_denylist',
      'project_id, campaign_id',
    ],
  ] as const)(
    'fails closed before any claim when the %s read fails',
    async (_label, table, columnsInclude) => {
      mockInstantlyDb = createMockSupabase({
        errorSelects: {
          [table]: { columnsInclude, message: `${table} read unavailable` },
        },
        rpcHandlers: campaignOwnershipRpcHandlers,
        tables: {
          instantly_campaign_catalog: mockInstantlyDb!.getRows('instantly_campaign_catalog'),
          project_instantly_campaigns: mockInstantlyDb!.getRows(
            'project_instantly_campaigns',
          ),
          project_period_instantly_campaigns: mockInstantlyDb!.getRows(
            'project_period_instantly_campaigns',
          ),
          project_instantly_campaigns_denylist: mockInstantlyDb!.getRows(
            'project_instantly_campaigns_denylist',
          ),
        },
      });

      const { autoMatchCampaignsToProjects } = await import(
        '@/lib/tools/instantlyCampaignCatalog'
      );

      const result = await autoMatchCampaignsToProjects();

      expect(result.matched).toBe(0);
      expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
    },
  );

  it('does not move an existing owner when the full campaign name matches two projects', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-existing', client: 'Acme' },
          { id: 'project-nested-name', client: 'Acme Labs' },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-ambiguous',
            name: 'Acme Labs outbound',
            timestamp_created: '2026-08-20T10:00:00Z',
            new_leads_contacted_count: 10,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'existing-link',
            project_id: 'project-existing',
            campaign_id: 'campaign-ambiguous',
            match_source: 'auto-text',
          },
        ],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({
        project_id: 'project-existing',
        campaign_id: 'campaign-ambiguous',
      }),
    ]);
  });

  it('keeps an older campaign owner in the ambiguity set despite its newer active period', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-existing', client: 'Acme' },
          { id: 'project-nested-name', client: 'Acme Labs' },
        ],
        project_periods: [
          {
            id: 'period-newer-than-campaign',
            project_id: 'project-existing',
            status: 'active',
            period_start: '2026-08-10',
            period_end: null,
            created_at: '2026-08-10T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-before-period',
            name: 'Acme Labs outbound',
            timestamp_created: '2026-08-01T10:00:00Z',
            new_leads_contacted_count: 10,
          },
        ],
        project_instantly_campaigns: [
          {
            id: 'existing-link',
            project_id: 'project-existing',
            campaign_id: 'campaign-before-period',
            match_source: 'auto-text',
          },
        ],
        project_period_instantly_campaigns: [],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(0);
    expect(mockInstantlyDb!.rpcCalls).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_instantly_campaigns')).toEqual([
      expect.objectContaining({
        project_id: 'project-existing',
        campaign_id: 'campaign-before-period',
      }),
    ]);
  });

  it('allows the same project to own one campaign across consecutive periods', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{ id: 'project-renewal', client: 'Acme' }],
        project_periods: [
          {
            id: 'period-old',
            project_id: 'project-renewal',
            status: 'closed',
            period_start: '2026-07-01',
            period_end: '2026-07-31',
            created_at: '2026-07-01T00:00:00Z',
          },
          {
            id: 'period-current',
            project_id: 'project-renewal',
            status: 'active',
            period_start: '2026-08-01',
            period_end: null,
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
            name: 'Acme August outreach',
            timestamp_created: '2026-08-02T10:00:00Z',
            new_leads_contacted_count: 0,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          {
            id: 'old-period-link',
            project_id: 'project-renewal',
            period_id: 'period-old',
            campaign_id: 'campaign-renewal',
            match_source: 'manual',
            baseline_contacts: 0,
          },
        ],
        project_instantly_campaigns_denylist: [],
      },
    });

    const { autoMatchCampaignsToProjects } = await import('@/lib/tools/instantlyCampaignCatalog');

    const result = await autoMatchCampaignsToProjects();

    expect(result.matched).toBe(1);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: 'project-renewal',
          period_id: 'period-old',
          campaign_id: 'campaign-renewal',
        }),
        expect.objectContaining({
          project_id: 'project-renewal',
          period_id: 'period-current',
          campaign_id: 'campaign-renewal',
        }),
      ]),
    );
  });
});
