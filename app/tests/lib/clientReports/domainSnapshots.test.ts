/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  buildAutoPipelineDomainSnapshot,
  buildLargeFileDomainSnapshot,
  buildManualScoringDomainSnapshot,
  persistDomainSnapshots,
} from '@/lib/clientReports/domainSnapshots';

const scoredAt = '2026-08-06T10:00:00.000Z';

describe('client pipeline domain snapshots', () => {
  it('maps auto-pipeline scoring, email validation and the successful route into one frozen row', () => {
    expect(buildAutoPipelineDomainSnapshot({
      clientUserId: 'client-1',
      runId: 'run-1',
      employerId: 'hh-42',
      domain: ' WWW.Example.com ',
      companyName: 'Example',
      score: 18_000,
      spf: 'v=spf1 -all',
      raw: { rating: 'B' },
      primaryEmail: { address: ' INFO@Example.com ', validationStatus: 'valid' },
      additionalEmails: [{ address: 'Sales@Example.com', validationStatus: 'invalid' }],
      scoredAt,
      routedCampaignId: 'campaign-b',
      routedCampaignName: 'High score',
      routedAt: scoredAt,
    })).toMatchObject({
      client_user_id: 'client-1',
      source_kind: 'auto_pipeline',
      source_run_id: 'run-1',
      source_row_id: 'hh-42',
      domain: 'example.com',
      score: 18_000,
      score_code: 'B',
      rating: 'B',
      email_found_count: 2,
      email_validated_count: 1,
      routed_campaign_id: 'campaign-b',
      routed_campaign_name_snapshot: 'High score',
      routed_at: scoredAt,
      metadata: {
        email: 'info@example.com',
        email_validation_status: 'valid',
        email2: 'sales@example.com',
        email2_validation_status: 'invalid',
        source_filename: null,
      },
    });
  });

  it('maps manual rows and large-file rows without conflating run and job identity', () => {
    expect(buildManualScoringDomainSnapshot({
      clientUserId: 'client-1', runId: 'manual-run', rowId: 7,
      domain: 'manual.test', companyName: 'Manual', score: 1_001,
      rating: 'C', spf: null, email: ' A@Manual.test ', emailValidationStatus: 'catch_all',
      email2: null, email2ValidationStatus: null, sourceFilename: ' domains.csv ', scoredAt,
    })).toMatchObject({
      source_kind: 'manual_scoring', source_run_id: 'manual-run', source_job_id: null,
      source_row_id: '7', score_code: 'C', email_found_count: 1, email_validated_count: 1,
      metadata: {
        email: 'a@manual.test', email_validation_status: 'catch_all',
        email2: null, email2_validation_status: null, source_filename: 'domains.csv',
      },
    });

    expect(buildLargeFileDomainSnapshot({
      clientUserId: 'client-1', jobId: 'large-job', rowId: 8,
      domain: 'large.test', score: 2_000_000, spf: 'spf', raw: { rating: 'A' },
      scoreOrigin: 'cache', sourceFilename: 'million.txt', scoredAt,
    })).toMatchObject({
      source_kind: 'large_score_file', source_run_id: null, source_job_id: 'large-job',
      source_row_id: '8', score_code: 'A', rating: 'A', score_origin: 'cache',
      email_found_count: 0, email_validated_count: 0,
      metadata: expect.objectContaining({ source_filename: 'million.txt' }),
    });
  });

  it('writes deterministic, retry-safe batches and ignores rows without a valid domain', async () => {
    const db = createMockSupabase({ tables: { client_pipeline_domain_snapshots: [] } });
    const snapshots = Array.from({ length: 501 }, (_, index) => buildLargeFileDomainSnapshot({
      clientUserId: 'client-1', jobId: 'job-1', rowId: index + 1,
      domain: `company-${index}.test`, score: index, spf: null, raw: null,
      scoreOrigin: 'api', scoredAt,
    }));
    snapshots.push(buildLargeFileDomainSnapshot({
      clientUserId: 'client-1', jobId: 'job-1', rowId: 999,
      domain: ' ', score: null, spf: null, raw: null,
      scoreOrigin: 'api', scoredAt,
    }));

    await persistDomainSnapshots(db as never, snapshots);
    const firstIds = db.getRows('client_pipeline_domain_snapshots').map((row) => row.id);
    await persistDomainSnapshots(db as never, snapshots);

    expect(db.upserts.filter((call) => call.table === 'client_pipeline_domain_snapshots')).toHaveLength(4);
    expect(db.getRows('client_pipeline_domain_snapshots')).toHaveLength(501);
    expect(db.getRows('client_pipeline_domain_snapshots').map((row) => row.id)).toEqual(firstIds);
  });

  it('fails closed when the durable snapshot table cannot be written', async () => {
    const db = createMockSupabase({
      tables: { client_pipeline_domain_snapshots: [] },
      errorTables: { client_pipeline_domain_snapshots: 'database unavailable' },
    });
    const snapshot = buildLargeFileDomainSnapshot({
      clientUserId: 'client-1', jobId: 'job-1', rowId: 1,
      domain: 'example.test', score: 5, spf: null, raw: null,
      scoreOrigin: 'api', scoredAt,
    });

    await expect(persistDomainSnapshots(db as never, [snapshot]))
      .rejects.toThrow('database unavailable');
  });
});
