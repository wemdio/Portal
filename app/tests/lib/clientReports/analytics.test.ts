/** @jest-environment node */

const datasetQueryMock = jest.fn();
const pipelineRpcMock = jest.fn();
const readCampaignAnalyticsFromDbMock = jest.fn();

jest.mock('@/lib/instantlyDataset', () => ({
  datasetQuery: (...args: unknown[]) => datasetQueryMock(...args),
}));
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => pipelineRpcMock(...args) },
}));
jest.mock('@/lib/tools/instantlyCampaignCatalog', () => ({
  readCampaignAnalyticsFromDb: (...args: unknown[]) => readCampaignAnalyticsFromDbMock(...args),
}));

import {
  buildReportQualityNotices,
  ClientReportPipelineUnavailableError,
  loadClientReportAnalytics,
  resolvePipelineCampaignNames,
} from '@/lib/clientReports/analytics';

const filters = {
  period: {
    preset: 'custom' as const,
    from: '2026-07-01',
    to: '2026-07-31',
    fromUtc: new Date('2026-06-30T21:00:00.000Z'),
    toExclusiveUtc: new Date('2026-07-31T21:00:00.000Z'),
  },
  score: 'B' as const,
  campaignId: 'campaign-a',
};

const pipelineRow = {
  scored_companies: 100,
  working_score_companies: 30,
  email_found_companies: 20,
  validated_emails: 18,
  submitted_contacts: 10,
  confirmed_contacts: 7,
  event_confirmed_contacts: 9,
  event_legacy_submitted_contacts: 2,
  legacy_scored_companies: 5,
  unattributed_confirmed_contacts: 1,
  pipeline_at: '2026-07-31T11:00:00.000Z',
  by_campaign: [{
    campaign_id: 'campaign-a',
    campaign_name: 'campaign-a',
    score_code: 'B',
    submitted: 10,
    confirmed: 7,
  }],
};

function loadAnalytics(overrides: Partial<Parameters<typeof loadClientReportAnalytics>[0]> = {}) {
  return loadClientReportAnalytics({
    clientUserId: 'client-1',
    allowedCampaignIds: ['campaign-a', 'campaign-b'],
    filters,
    ...overrides,
  });
}

describe('client reports pipeline analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    datasetQueryMock.mockRejectedValue(new Error('canceling statement due to statement timeout'));
    readCampaignAnalyticsFromDbMock.mockResolvedValue({
      campaigns: [{ id: 'campaign-a', name: 'Campaign A' }],
      lastSyncedAt: '2026-07-31T12:00:00.000Z',
    });
    pipelineRpcMock.mockImplementation(async (name: string) => {
      if (name === 'client_report_large_score_rollup_active_run') {
        return { data: null, error: null };
      }
      return { data: [pipelineRow], error: null };
    });
  });

  it('explains pipeline limitations without outreach-only counters', () => {
    expect(buildReportQualityNotices({
      campaignId: 'campaign-a',
      legacyScoredCompanies: 125,
      legacySubmittedContacts: 9,
      unattributedConfirmedContacts: 4,
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/историческ/i),
      expect.stringMatching(/этапа передачи/i),
      expect.stringMatching(/4 подтвержд/i),
    ]));
  });

  it('does not show quality warnings for a fully covered exact pipeline report', () => {
    expect(buildReportQualityNotices({
      campaignId: null,
      legacyScoredCompanies: 0,
      legacySubmittedContacts: 0,
      unattributedConfirmedContacts: 0,
    })).toEqual([]);
  });

  it('replaces legacy campaign-id labels with the operational catalog name', () => {
    expect(resolvePipelineCampaignNames([{
      campaignId: 'campaign-a',
      campaignName: 'campaign-a',
      scoreCode: 'A',
      submitted: 12,
      confirmed: 0,
    }], [
      { id: 'campaign-a', name: 'Mailganer — высокий скор' },
    ])).toEqual([
      expect.objectContaining({ campaignName: 'Mailganer — высокий скор' }),
    ]);
  });

  it('loads a pipeline-only payload without querying instantly_dataset', async () => {
    const result = await loadAnalytics();

    expect(datasetQueryMock).not.toHaveBeenCalled();
    expect(readCampaignAnalyticsFromDbMock).toHaveBeenCalledWith([
      'campaign-a',
      'campaign-b',
    ]);
    expect(pipelineRpcMock).toHaveBeenNthCalledWith(
      1,
      'client_report_large_score_rollup_active_run',
      { p_client_user_id: 'client-1' },
    );
    expect(pipelineRpcMock).toHaveBeenNthCalledWith(
      2,
      'client_report_pipeline_summary',
      {
        p_client_user_id: 'client-1',
        p_from: '2026-06-30T21:00:00.000Z',
        p_to: '2026-07-31T21:00:00.000Z',
        p_score_code: 'B',
        p_campaign_id: 'campaign-a',
        p_allowed_campaign_ids: ['campaign-a', 'campaign-b'],
      },
    );

    expect(result).not.toHaveProperty('metrics');
    expect(result.freshness).toEqual({ pipelineAt: '2026-07-31T11:00:00.000Z' });
    expect(result.freshness).not.toHaveProperty('analyticsAt');
    expect(result.campaigns).toEqual([
      { id: 'campaign-a', name: 'Campaign A' },
      { id: 'campaign-b', name: 'campaign-b' },
    ]);
    expect(result.funnel).toEqual(expect.objectContaining({
      scoredCompanies: 100,
      workingScoreCompanies: 30,
      emailFoundCompanies: 20,
      validatedEmails: 18,
      submittedContacts: 10,
      confirmedContacts: 7,
      byCampaign: [expect.objectContaining({
        campaignId: 'campaign-a',
        campaignName: 'Campaign A',
        scoreCode: 'B',
        submitted: 10,
        confirmed: 7,
      })],
    }));
    expect(result.qualityNotices).toHaveLength(3);
  });

  it('uses the tenant-owned active rollup while preserving every report filter', async () => {
    pipelineRpcMock.mockImplementation(async (name: string) => {
      if (name === 'client_report_large_score_rollup_active_run') {
        return {
          data: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          error: null,
        };
      }
      if (name === 'client_report_pipeline_summary_shadow') {
        return { data: [pipelineRow], error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    await loadAnalytics();

    expect(pipelineRpcMock).toHaveBeenNthCalledWith(
      2,
      'client_report_pipeline_summary_shadow',
      {
        p_client_user_id: 'client-1',
        p_rollup_run_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        p_from: '2026-06-30T21:00:00.000Z',
        p_to: '2026-07-31T21:00:00.000Z',
        p_score_code: 'B',
        p_campaign_id: 'campaign-a',
        p_allowed_campaign_ids: ['campaign-a', 'campaign-b'],
      },
    );
    expect(pipelineRpcMock.mock.calls).not.toContainEqual([
      'client_report_pipeline_summary',
      expect.anything(),
    ]);
  });

  it.each([
    ['activation lookup fails', 'lookup'],
    ['active shadow fails', 'shadow'],
  ])('falls back to the unchanged report RPC when %s', async (_case, failure) => {
    pipelineRpcMock.mockImplementation(async (name: string) => {
      if (name === 'client_report_large_score_rollup_active_run') {
        if (failure === 'lookup') {
          return { data: null, error: { message: 'selector unavailable' } };
        }
        return {
          data: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          error: null,
        };
      }
      if (name === 'client_report_pipeline_summary_shadow') {
        return { data: null, error: { message: 'shadow unavailable' } };
      }
      if (name === 'client_report_pipeline_summary') {
        return { data: [pipelineRow], error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    const result = await loadAnalytics();

    expect(result.funnel.scoredCompanies).toBe(100);
    expect(pipelineRpcMock).toHaveBeenCalledWith(
      'client_report_pipeline_summary',
      expect.objectContaining({
        p_client_user_id: 'client-1',
        p_allowed_campaign_ids: ['campaign-a', 'campaign-b'],
      }),
    );
  });

  it.each([
    ['null', null],
    ['empty array', []],
  ])('falls back when an active shadow returns %s without an RPC error', async (
    _case,
    shadowData,
  ) => {
    pipelineRpcMock.mockImplementation(async (name: string) => {
      if (name === 'client_report_large_score_rollup_active_run') {
        return { data: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', error: null };
      }
      if (name === 'client_report_pipeline_summary_shadow') {
        return { data: shadowData, error: null };
      }
      if (name === 'client_report_pipeline_summary') {
        return { data: [pipelineRow], error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    const result = await loadAnalytics();

    expect(result.funnel.scoredCompanies).toBe(100);
    expect(pipelineRpcMock).toHaveBeenCalledWith(
      'client_report_pipeline_summary',
      expect.any(Object),
    );
  });

  it('keeps pipeline analytics available when the campaign catalog lookup fails', async () => {
    readCampaignAnalyticsFromDbMock.mockRejectedValueOnce(new Error('catalog unavailable'));

    const result = await loadAnalytics();

    expect(result.campaigns).toEqual([
      { id: 'campaign-a', name: 'campaign-a' },
      { id: 'campaign-b', name: 'campaign-b' },
    ]);
    expect(result.funnel.byCampaign).toEqual([
      expect.objectContaining({ campaignId: 'campaign-a', campaignName: 'campaign-a' }),
    ]);
    expect(datasetQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: 'empty',
      catalogCampaigns: [],
      expectedCampaigns: [
        { id: 'campaign-a', name: 'campaign-a' },
        { id: 'campaign-b', name: 'campaign-b' },
      ],
    },
    {
      caseName: 'partial with an out-of-scope row',
      catalogCampaigns: [
        { id: 'campaign-a', name: 'Campaign A' },
        { id: 'foreign-campaign', name: 'Must not leak' },
      ],
      expectedCampaigns: [
        { id: 'campaign-a', name: 'Campaign A' },
        { id: 'campaign-b', name: 'campaign-b' },
      ],
    },
  ])('keeps the complete allowlist for a $caseName catalog result', async ({
    catalogCampaigns,
    expectedCampaigns,
  }) => {
    readCampaignAnalyticsFromDbMock.mockResolvedValueOnce({
      campaigns: catalogCampaigns,
      lastSyncedAt: null,
    });

    const result = await loadAnalytics();

    expect(result.campaigns).toEqual(expectedCampaigns);
    expect(result.campaigns).not.toContainEqual(expect.objectContaining({
      id: 'foreign-campaign',
    }));
  });

  it('turns a pipeline RPC failure into a typed client-safe error', async () => {
    pipelineRpcMock.mockImplementation(async (name: string) => {
      if (name === 'client_report_large_score_rollup_active_run') {
        return { data: null, error: null };
      }
      return {
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      };
    });

    const error = await loadAnalytics().catch((caught: unknown) => caught);

    expect(error).toEqual(expect.objectContaining({
      name: 'ClientReportPipelineUnavailableError',
      message: 'Воронка базы временно недоступна. Повторите попытку позже.',
    }));
    expect(error).toBeInstanceOf(ClientReportPipelineUnavailableError);
    expect(error).not.toHaveProperty('message', expect.stringMatching(/statement timeout/i));
  });
});
