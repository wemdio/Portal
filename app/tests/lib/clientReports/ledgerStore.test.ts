/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  completeAppendLedgerBatch,
  failAppendLedgerBatch,
  startAppendLedgerBatch,
} from '@/lib/clientReports/ledgerStore';

const leads = [
  { email: 'one@example.com', company_name: 'One', custom_variables: { domain: 'example.com', score: '1001' } },
  { email: 'two@example.com', company_name: 'Two', custom_variables: { domain: 'example.com', score: '1001' } },
];

describe('client report append ledger persistence', () => {
  it('writes the batch and submitted contact events before external delivery', async () => {
    const db = createMockSupabase({ tables: {
      client_campaign_append_batches: [], client_campaign_contact_ledger: [],
    } });

    const started = await startAppendLedgerBatch(db as never, {
      clientUserId: 'client-1', campaignId: 'campaign-1', campaignName: 'C',
      sourceKind: 'auto_pipeline', sourceRunId: 'run-1', sourceJobId: 'job-1', leads,
      blockedCount: 1, tariffSkippedCount: 2, startedAt: '2026-08-06T10:00:00Z',
    });

    expect(db.getRows('client_campaign_append_batches')[0]).toMatchObject({
      id: started.batchId,
      requested_count: 2,
      accepted_count: 0,
      score_code: 'C',
      source_job_id: 'job-1',
      status: 'submitted',
    });
    expect(db.getRows('client_campaign_contact_ledger')).toHaveLength(2);
    expect(db.getRows('client_campaign_contact_ledger')[0]).toMatchObject({
      append_status: 'submitted', source_job_id: 'job-1',
    });
  });

  it('stores the exact partial aggregate and provider-confirmed identity snapshot', async () => {
    const db = createMockSupabase({ tables: {
      client_campaign_append_batches: [{ id: 'batch-1', status: 'submitted' }],
      client_campaign_contact_ledger: [],
    } });

    await completeAppendLedgerBatch(db as never, {
      batchId: 'batch-1', clientUserId: 'client-1', campaignId: 'campaign-1',
      campaignName: 'C', sourceKind: 'auto_pipeline', sourceRunId: 'run-1',
      leads, accepted: 1, skipped: 1,
      createdLeads: [{ id: 'external-1', email: 'one@example.com', index: 0 }],
      finishedAt: '2026-08-06T10:01:00Z',
    });

    expect(db.getRows('client_campaign_append_batches')[0]).toMatchObject({
      accepted_count: 1, skipped_count: 1, status: 'completed', identity_complete: true,
      accepted_identities: [{ externalContactId: 'external-1', email: 'one@example.com', index: 0 }],
    });
    expect(db.getRows('client_campaign_contact_ledger')).toHaveLength(0);
  });

  it('marks all-or-none outcomes identity-complete for the database trigger', async () => {
    const db = createMockSupabase({ tables: {
      client_campaign_append_batches: [{ id: 'batch-1', status: 'submitted' }],
      client_campaign_contact_ledger: [],
    } });

    await completeAppendLedgerBatch(db as never, {
      batchId: 'batch-1', clientUserId: 'client-1', campaignId: 'campaign-1',
      campaignName: 'C', sourceKind: 'auto_pipeline', sourceRunId: 'run-1',
      leads, accepted: 2, skipped: 0, finishedAt: '2026-08-06T10:01:00Z',
    });

    expect(db.getRows('client_campaign_append_batches')[0]).toMatchObject({
      status: 'completed', identity_complete: true,
    });
    expect(db.getRows('client_campaign_contact_ledger')).toHaveLength(0);
  });

  it('closes the batch as identity-complete on delivery failure for the database trigger', async () => {
    const db = createMockSupabase({ tables: {
      client_campaign_append_batches: [{ id: 'batch-1', status: 'submitted' }],
      client_campaign_contact_ledger: [],
    } });

    await failAppendLedgerBatch(db as never, {
      batchId: 'batch-1', clientUserId: 'client-1', campaignId: 'campaign-1',
      campaignName: 'C', sourceKind: 'auto_pipeline', sourceRunId: 'run-1', leads,
      error: 'network timeout', finishedAt: '2026-08-06T10:01:00Z',
    });

    expect(db.getRows('client_campaign_append_batches')[0]).toMatchObject({
      status: 'failed', identity_complete: true,
    });
    expect(db.getRows('client_campaign_contact_ledger')).toHaveLength(0);
  });

  it('closes a batch as identity-complete if the pre-delivery contact journal fails', async () => {
    const db = createMockSupabase({
      tables: { client_campaign_append_batches: [], client_campaign_contact_ledger: [] },
      errorInserts: {
        client_campaign_contact_ledger: { code: '42P01', message: 'contact ledger unavailable' },
      },
    });

    await expect(startAppendLedgerBatch(db as never, {
      clientUserId: 'client-1', campaignId: 'campaign-1', sourceKind: 'auto_pipeline',
      leads, blockedCount: 0, tariffSkippedCount: 0, startedAt: '2026-08-06T10:00:00Z',
    })).rejects.toThrow(/contact ledger/i);

    expect(db.getRows('client_campaign_append_batches')[0]).toMatchObject({
      status: 'failed', identity_complete: true,
    });
  });

  it('fails closed when a terminal transition matches no durable batch', async () => {
    const db = createMockSupabase({ tables: {
      client_campaign_append_batches: [], client_campaign_contact_ledger: [],
    } });

    await expect(completeAppendLedgerBatch(db as never, {
      batchId: 'missing-batch', clientUserId: 'client-1', campaignId: 'campaign-1',
      sourceKind: 'auto_pipeline', leads, accepted: 2, skipped: 0,
      finishedAt: '2026-08-06T10:01:00Z',
    })).rejects.toThrow(/completion write failed/i);

    await expect(failAppendLedgerBatch(db as never, {
      batchId: 'missing-batch', clientUserId: 'client-1', campaignId: 'campaign-1',
      sourceKind: 'auto_pipeline', leads, error: 'network timeout',
      finishedAt: '2026-08-06T10:01:00Z',
    })).rejects.toThrow(/failure write failed/i);
  });

  it('fails before creating a batch when not every requested lead has a durable contact identity', async () => {
    const db = createMockSupabase({ tables: {
      client_campaign_append_batches: [], client_campaign_contact_ledger: [],
    } });
    const malformed = [
      leads[0],
      { email: '   ', company_name: 'Missing identity', custom_variables: { score: '1001' } },
    ];

    await expect(startAppendLedgerBatch(db as never, {
      clientUserId: 'client-1', campaignId: 'campaign-1', sourceKind: 'auto_pipeline',
      leads: malformed, blockedCount: 0, tariffSkippedCount: 0,
      startedAt: '2026-08-06T10:00:00Z',
    })).rejects.toThrow(/contact identit/i);

    expect(db.getRows('client_campaign_append_batches')).toHaveLength(0);
    expect(db.getRows('client_campaign_contact_ledger')).toHaveLength(0);
  });
});
