/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));
jest.mock('@/lib/jobs/mailganerScoreCache', () => ({
  getOrFetchScore: jest.fn(),
  normalizeDomain: (value: string) => value.trim().toLowerCase() || null,
}));
jest.mock('@/lib/jobs/autoPipelineEmailValidation', () => ({
  validateEmailForAutoPipeline: jest.fn(),
}));
jest.mock('@/lib/enrich/emailScraper', () => ({ scrapeEmails: jest.fn() }));
jest.mock('@/lib/companyNameCleanupBatch', () => ({ cleanCompanyNames: jest.fn() }));
jest.mock('@/lib/clientLaunch/appendLeads', () => ({ appendLeadsToClientCampaign: jest.fn() }));

import {
  persistManualProcessedRow,
  processManualRun,
} from '@/lib/jobs/manualScoringRunner';
import { cleanCompanyNames } from '@/lib/companyNameCleanupBatch';
import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';

const cleanCompanyNamesMock = cleanCompanyNames as jest.MockedFunction<typeof cleanCompanyNames>;
const appendLeadsMock = appendLeadsToClientCampaign as jest.MockedFunction<typeof appendLeadsToClientCampaign>;

const endpoint = { url: 'https://score.test', apiKey: '', authScheme: 'Bearer', timeoutMs: 1000 };

function seed(errorSnapshots = false) {
  return createMockSupabase({
    tables: {
      client_manual_score_runs: [{
        id: 'manual-run', client_user_id: 'client-1', source_filename: 'manual.csv',
        route_to_instantly: false, status: 'processing',
      }],
      client_manual_score_rows: [{
        id: 7, run_id: 'manual-run', domain: 'manual.test', company_name: null,
        score: 0, rating: 'D', spf: 'v=spf1 -all', email: null,
        email_validation_status: null, email2: null, email2_validation_status: null,
        bucket: 'storage', processed_at: '2026-08-06T10:00:00.000Z',
      }],
      client_pipeline_domain_snapshots: [],
    },
    errorTables: errorSnapshots
      ? { client_pipeline_domain_snapshots: 'snapshot database unavailable' }
      : undefined,
  });
}

function routeSeed(errorSelects?: Record<string, { columnsInclude: string; message: string }>) {
  return createMockSupabase({ tables: {
    client_manual_score_runs: [{
      id: 'manual-run', client_user_id: 'client-1', source_filename: 'manual.csv',
      route_to_instantly: true, status: 'processing',
    }],
    client_manual_score_rows: [
      {
        id: 7, run_id: 'manual-run', domain: 'one.test', company_name: null,
        score: 20_000, rating: 'B', spf: 'v=spf1 -all', email: 'one@one.test',
        email_validation_status: 'valid', email2: null, email2_validation_status: null,
        bucket: 'high', processed_at: '2026-08-06T10:00:00.000Z', scraped_name: 'One',
      },
      {
        id: 8, run_id: 'manual-run', domain: 'two.test', company_name: null,
        score: 20_000, rating: 'B', spf: 'v=spf1 -all', email: 'two@two.test',
        email_validation_status: 'valid', email2: null, email2_validation_status: null,
        bucket: 'high', processed_at: '2026-08-06T10:00:01.000Z', scraped_name: 'Two',
      },
    ],
    mailganer_domain_scores: [],
    client_auto_pipeline_configs: [{
      client_user_id: 'client-1',
      score_buckets: [{
        score_min: 15_001, score_max: 1_000_000, instantly_campaign_id: 'campaign-b',
        label: 'B campaign', sequence: { steps: [{}] },
      }],
    }],
    client_pipeline_domain_snapshots: [],
    client_campaign_contact_ledger: [],
  }, errorSelects });
}

describe('manual scoring durable snapshot reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('repairs a missing immutable snapshot before finalizing an already-processed run', async () => {
    mockDb = seed();

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'completed', total: 1 });
    expect(mockDb.getRows('client_pipeline_domain_snapshots')[0]).toMatchObject({
      client_user_id: 'client-1', source_kind: 'manual_scoring',
      source_run_id: 'manual-run', source_row_id: '7', domain: 'manual.test',
      score: 0, score_code: 'rejected', rating: 'D',
      metadata: expect.objectContaining({ source_filename: 'manual.csv' }),
    });
  });

  it('does not finalize the run when snapshot reconciliation fails', async () => {
    mockDb = seed(true);

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: 'snapshot database unavailable' });
    expect(mockDb.getRows('client_manual_score_runs')[0]).toMatchObject({ status: 'failed' });
  });

  it('fails closed when processed rows cannot be loaded for routing', async () => {
    mockDb = routeSeed({
      client_manual_score_rows: {
        columnsInclude: 'scraped_name',
        message: 'manual routing rows unavailable',
      },
    });

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: 'manual routing rows unavailable' });
    expect(appendLeadsMock).not.toHaveBeenCalled();
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);
  });

  it('fails closed when campaign routing configuration cannot be loaded', async () => {
    mockDb = routeSeed({
      client_auto_pipeline_configs: {
        columnsInclude: 'score_buckets',
        message: 'routing config unavailable',
      },
    });
    cleanCompanyNamesMock.mockResolvedValue(['One', 'Two']);

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: 'routing config unavailable' });
    expect(appendLeadsMock).not.toHaveBeenCalled();
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);
  });

  it('marks only exact provider-accepted manual rows as routed during reconciliation', async () => {
    mockDb = routeSeed();
    cleanCompanyNamesMock.mockResolvedValue(['One', 'Two']);
    appendLeadsMock.mockResolvedValue({
      accepted: 1, skipped: 1, acceptedIndexes: [1], identityComplete: true,
    });

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'completed' });

    expect(appendLeadsMock).toHaveBeenCalledTimes(1);
    expect(appendLeadsMock.mock.calls[0][0].leads.map((lead) => lead.custom_variables?.source_row_id))
      .toEqual(['7', '8']);
    const snapshots = mockDb.getRows('client_pipeline_domain_snapshots');
    expect(snapshots.find((row) => row.source_row_id === '7')).toMatchObject({
      routed_campaign_id: null,
    });
    expect(snapshots.find((row) => row.source_row_id === '8')).toMatchObject({
      routed_campaign_id: 'campaign-b',
      routed_campaign_name_snapshot: 'B campaign',
    });
  });

  it('keeps a failed manual append retryable and does not freeze an unrouted snapshot', async () => {
    mockDb = routeSeed();
    cleanCompanyNamesMock.mockResolvedValue(['One', 'Two']);
    appendLeadsMock.mockRejectedValueOnce(new Error('provider timeout'));

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: 'provider timeout' });
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);

    appendLeadsMock.mockResolvedValueOnce({
      accepted: 2, skipped: 0, acceptedIndexes: [0, 1], identityComplete: true,
    });
    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'completed' });

    expect(appendLeadsMock).toHaveBeenCalledTimes(2);
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_row_id: '7', routed_campaign_id: 'campaign-b' }),
      expect.objectContaining({ source_row_id: '8', routed_campaign_id: 'campaign-b' }),
    ]));
  });

  it('persists exact partial acceptance and does not resend that row on retry', async () => {
    mockDb = routeSeed();
    cleanCompanyNamesMock.mockImplementation(async (rows) => rows.map((row) => row.name ?? ''));
    const partialError = Object.assign(new Error('journal completion unavailable'), {
      partialResult: {
        accepted: 1,
        skipped: 1,
        acceptedIndexes: [1],
        identityComplete: true,
      },
    });
    appendLeadsMock.mockRejectedValueOnce(partialError);

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed' });
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toEqual([
      expect.objectContaining({ source_row_id: '8', routed_campaign_id: 'campaign-b' }),
    ]);

    appendLeadsMock.mockResolvedValueOnce({
      accepted: 1, skipped: 0, acceptedIndexes: [0], identityComplete: true,
    });
    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'completed' });

    expect(appendLeadsMock).toHaveBeenCalledTimes(2);
    expect(appendLeadsMock.mock.calls[1][0].leads.map((lead) => lead.custom_variables?.source_row_id))
      .toEqual(['7']);
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_row_id: '7', routed_campaign_id: 'campaign-b' }),
      expect.objectContaining({ source_row_id: '8', routed_campaign_id: 'campaign-b' }),
    ]));
  });

  it('keeps earlier exact campaign routes when a later campaign returns aggregate-only identities', async () => {
    mockDb = routeSeed();
    const rows = mockDb.getRows('client_manual_score_rows');
    mockDb = createMockSupabase({ tables: {
      client_manual_score_runs: mockDb.getRows('client_manual_score_runs'),
      client_manual_score_rows: [rows[0], { ...rows[1], score: 1_001, bucket: 'medium' }],
      mailganer_domain_scores: [],
      client_auto_pipeline_configs: [{
        client_user_id: 'client-1',
        score_buckets: [
          {
            score_min: 15_001, score_max: 1_000_000, instantly_campaign_id: 'campaign-b',
            label: 'B campaign', sequence: { steps: [{}] },
          },
          {
            score_min: 1_001, score_max: 15_000, instantly_campaign_id: 'campaign-c',
            label: 'C campaign', sequence: { steps: [{}] },
          },
        ],
      }],
      client_pipeline_domain_snapshots: [],
    } });
    cleanCompanyNamesMock.mockImplementation(async (items) => items.map((item) => item.name ?? ''));
    appendLeadsMock
      .mockResolvedValueOnce({ accepted: 1, skipped: 0, acceptedIndexes: [0], identityComplete: true })
      .mockRejectedValueOnce(Object.assign(new Error('aggregate-only'), {
        partialResult: {
          accepted: 1, skipped: 0, acceptedIndexes: null, identityComplete: false,
        },
      }));

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed' });
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toEqual([
      expect.objectContaining({ source_row_id: '7', routed_campaign_id: 'campaign-b' }),
    ]);
  });

  it('throws when the scored row cannot be durably written', async () => {
    mockDb = createMockSupabase({
      tables: { client_manual_score_rows: [{ id: 7 }] },
      errorTables: { client_manual_score_rows: 'manual row write unavailable' },
    });

    await expect(persistManualProcessedRow(7, {
      domain: 'manual.test', score: 1_001, rating: 'C', spf: 'v=spf1 -all',
      email: null, emailValidationStatus: null, email2: null,
      email2ValidationStatus: null, bucket: 'medium', errorMessage: null,
      scrapedName: null,
    }, '2026-08-06T10:00:00.000Z')).rejects.toThrow('manual row write unavailable');
  });
});
