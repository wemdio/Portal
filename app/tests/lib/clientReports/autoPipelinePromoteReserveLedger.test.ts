/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;
const appendLeadsMock = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/clientLaunch/appendLeads', () => ({
  appendLeadsToClientCampaign: (...args: unknown[]) => appendLeadsMock(...args),
}));

import {
  buildReservePromotionRunId,
  runPromoteReserve,
} from '@/lib/jobs/autoPipelinePromoteReserve';

function seed(): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      client_auto_pipeline_configs: [{
        client_user_id: 'client-1',
        score_buckets: [{
          id: 'bucket-c', label: 'C', score_min: 1_001, score_max: null,
          instantly_campaign_id: 'campaign-c',
          sequence: { steps: [{ subject: 'Hello', body: 'Body' }] },
        }],
      }],
      client_auto_pipeline_seen_employers: [{
        client_user_id: 'client-1', hh_employer_id: 'hh-1', status: 'dry_run',
        company_name: 'One', site_url: 'https://one.test', domain: 'one.test',
        endpoint_score: 1_001, source: 'hh', resolved_email: 'one@one.test',
        email_validation_status: 'valid', email2: 'two@one.test',
        email2_validation_status: 'valid',
      }, {
        client_user_id: 'client-1', hh_employer_id: 'hh-2', status: 'dry_run',
        company_name: 'Two', site_url: 'https://two.test', domain: 'two.test',
        endpoint_score: 1_002, source: 'hh', resolved_email: 'hello@two.test',
        email_validation_status: 'valid', email2: null,
        email2_validation_status: null,
      }],
      client_pipeline_domain_snapshots: [{
        id: '123e4567-e89b-12d3-a456-426614174001', client_user_id: 'client-1',
        source_kind: 'auto_pipeline', source_run_id: 'original-run-1', source_job_id: null,
        source_row_id: 'hh-1', legacy_inferred: false, scored_at: '2026-08-05T10:00:00Z',
      }, {
        id: '123e4567-e89b-12d3-a456-426614174002', client_user_id: 'client-1',
        source_kind: 'auto_pipeline', source_run_id: 'original-run-2', source_job_id: null,
        source_row_id: 'hh-2', legacy_inferred: false, scored_at: '2026-08-05T10:00:00Z',
      }],
    },
  });
}

describe('reserve promotion durable append provenance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = seed();
  });

  it('builds an order-independent run identity scoped to the client and campaign', () => {
    expect(buildReservePromotionRunId('client-1', 'campaign-c', ['hh-2', 'hh-1']))
      .toBe(buildReservePromotionRunId('client-1', 'campaign-c', ['hh-1', 'hh-2']));
    expect(buildReservePromotionRunId('client-1', 'campaign-c', ['hh-1']))
      .not.toBe(buildReservePromotionRunId('client-1', 'campaign-b', ['hh-1']));
  });

  it('journals stable source provenance and routes only exactly accepted source rows', async () => {
    appendLeadsMock.mockResolvedValue({
      accepted: 1, skipped: 2, acceptedIndexes: [1], identityComplete: true,
    });

    await expect(runPromoteReserve('client-1')).resolves.toMatchObject({
      totalRows: 2,
      results: [{ campaign: 'campaign-c', accepted: 1 }],
    });

    expect(appendLeadsMock).toHaveBeenCalledTimes(1);
    const appendInput = appendLeadsMock.mock.calls[0][0];
    expect(appendInput.ledgerSource).toMatchObject({
      kind: 'auto_pipeline', campaignName: 'C',
      runId: buildReservePromotionRunId('client-1', 'campaign-c', ['hh-1', 'hh-2']),
    });
    expect(appendInput.leads.map((lead: { custom_variables?: Record<string, string> }) => (
      lead.custom_variables?.source_row_id
    ))).toEqual(['hh-1', 'hh-1', 'hh-2']);
    expect(appendInput.leads.map((lead: { custom_variables?: Record<string, string> }) => (
      lead.custom_variables?.source_run_id
    ))).toEqual(['original-run-1', 'original-run-1', 'original-run-2']);
    expect(appendInput.leads.map((lead: { custom_variables?: Record<string, string> }) => (
      lead.custom_variables?.domain_snapshot_id
    ))).toEqual([
      '123e4567-e89b-12d3-a456-426614174001',
      '123e4567-e89b-12d3-a456-426614174001',
      '123e4567-e89b-12d3-a456-426614174002',
    ]);

    expect(mockDb.getRows('client_auto_pipeline_seen_employers')).toEqual(expect.arrayContaining([
      expect.objectContaining({ hh_employer_id: 'hh-1', status: 'routed' }),
      expect.objectContaining({ hh_employer_id: 'hh-2', status: 'dry_run' }),
    ]));
  });

  it('never selects a newer manual snapshot with the same numeric source row id', async () => {
    const base = seed();
    mockDb = createMockSupabase({
      tables: {
        client_auto_pipeline_configs: base.getRows('client_auto_pipeline_configs'),
        client_auto_pipeline_seen_employers: [{
          client_user_id: 'client-1', hh_employer_id: '42', status: 'dry_run',
          company_name: 'Numeric HH', site_url: 'https://numeric.test', domain: 'numeric.test',
          endpoint_score: 1_001, source: 'hh', resolved_email: 'hello@numeric.test',
          email_validation_status: 'valid', email2: null, email2_validation_status: null,
        }],
        client_pipeline_domain_snapshots: [{
          id: '123e4567-e89b-12d3-a456-426614174099', client_user_id: 'client-1',
          source_kind: 'manual_scoring', source_run_id: 'manual-run-newer', source_job_id: null,
          source_row_id: '42', legacy_inferred: false, scored_at: '2026-08-06T10:00:00Z',
        }, {
          id: '123e4567-e89b-12d3-a456-426614174042', client_user_id: 'client-1',
          source_kind: 'auto_pipeline', source_run_id: 'original-auto-run', source_job_id: null,
          source_row_id: '42', legacy_inferred: false, scored_at: '2026-08-05T10:00:00Z',
        }],
      },
    });
    appendLeadsMock.mockResolvedValue({
      accepted: 1, skipped: 0, acceptedIndexes: [0], identityComplete: true,
    });

    await runPromoteReserve('client-1');

    const lead = appendLeadsMock.mock.calls[0][0].leads[0];
    expect(lead.custom_variables).toMatchObject({
      source_kind: 'auto_pipeline',
      source_run_id: 'original-auto-run',
      domain_snapshot_id: '123e4567-e89b-12d3-a456-426614174042',
    });
  });

  it('does not mark any source row routed from an aggregate-only accepted count', async () => {
    appendLeadsMock.mockResolvedValue({
      accepted: 1, skipped: 2, acceptedIndexes: null, identityComplete: false,
    });

    await expect(runPromoteReserve('client-1'))
      .rejects.toThrow(/without exact identities/i);
    expect(mockDb.getRows('client_auto_pipeline_seen_employers')).toEqual(expect.arrayContaining([
      expect.objectContaining({ hh_employer_id: 'hh-1', status: 'dry_run' }),
      expect.objectContaining({ hh_employer_id: 'hh-2', status: 'dry_run' }),
    ]));
  });
});
