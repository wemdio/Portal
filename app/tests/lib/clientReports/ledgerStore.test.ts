/** @jest-environment node */

import { Readable } from 'node:stream';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import {
  completeAppendLedgerBatch,
  failAppendLedgerBatch,
  startAppendLedgerBatch,
} from '@/lib/clientReports/ledgerStore';

let largeScoreDb: MockSupabaseClient;
const getMainS3ObjectStreamMock = jest.fn();
const getCachedScoresMock = jest.fn();
const getOrFetchScoreMock = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return largeScoreDb;
  },
}));
jest.mock('@/lib/mainS3Server', () => ({
  getMainS3ObjectStream: (...args: unknown[]) => getMainS3ObjectStreamMock(...args),
}));
jest.mock('@/lib/jobs/mailganerScoreCache', () => ({
  getCachedScores: (...args: unknown[]) => getCachedScoresMock(...args),
  getOrFetchScore: (...args: unknown[]) => getOrFetchScoreMock(...args),
  normalizeDomain: (value: string) => value.trim().toLowerCase() || null,
  emptyCacheStats: () => ({ hits: 0, misses: 0, errors: 0 }),
}));
import { processNextLargeScoreWork } from '@/lib/jobs/largeScoreEngine';

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

describe('large-score client domain exclusion persistence', () => {
  const mailganerClientId = '0a6d90e1-91d0-404e-b508-6b031bda7cfd';
  const endpoint = {
    url: 'https://score.test', apiKey: '', authScheme: 'Bearer', timeoutMs: 1_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getCachedScoresMock.mockImplementation(async (domains: string[]) => new Map(
      domains.map((domain) => [domain, {
        ok: true, score: 42_000, spf: 'v=spf1 -all', raw: { rating: 'B' },
      }]),
    ));
  });

  it('persists excluded domains during intake without turning them into score facts', async () => {
    largeScoreDb = createMockSupabase({ tables: {
      large_score_jobs: [{
        id: 'job-parse', client_user_id: mailganerClientId, s3_key: 'input.txt',
        source_filename: 'domains.txt', status: 'parsing', parse_offset: 0,
        parsed_domains: 0, junk_domains: 0, scored_domains: 0, active_domains: 0,
        cached_domains: 0, excluded_domains: 7,
      }],
      large_score_domains: [],
    } });
    getMainS3ObjectStreamMock.mockResolvedValue(Readable.from([
      'blocked.com\nkept.com.ru\nkept.test\n',
    ]));

    await expect(processNextLargeScoreWork(endpoint, 1)).resolves.toBe(true);

    expect(largeScoreDb.getRows('large_score_domains')).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: 'job-parse', domain: 'blocked.com', status: 'excluded' }),
      expect.objectContaining({ job_id: 'job-parse', domain: 'kept.com.ru', status: 'pending' }),
      expect.objectContaining({ job_id: 'job-parse', domain: 'kept.test', status: 'pending' }),
    ]));
    // The unit DB has no triggers: the SQL-owned counter must not be overwritten
    // by an application-side estimate while parsing.
    expect(largeScoreDb.getRows('large_score_jobs')[0]).toMatchObject({
      status: 'scoring', total_domains: 3, excluded_domains: 7,
    });
    expect(getCachedScoresMock).not.toHaveBeenCalled();
    expect(getOrFetchScoreMock).not.toHaveBeenCalled();
  });

  it('keeps parsing open when the exact deduplicated total cannot be read', async () => {
    largeScoreDb = createMockSupabase({
      tables: {
        large_score_jobs: [{
          id: 'job-count-error', client_user_id: mailganerClientId, s3_key: 'input.txt',
          source_filename: 'domains.txt', status: 'parsing', parse_offset: 0,
          parsed_domains: 0, junk_domains: 0, scored_domains: 0, active_domains: 0,
          cached_domains: 0, excluded_domains: 0, total_domains: 0,
        }],
        large_score_domains: [],
      },
      errorSelects: {
        large_score_domains: { columnsInclude: 'id', message: 'count unavailable' },
      },
    });
    getMainS3ObjectStreamMock.mockResolvedValue(Readable.from(['one.com.ru\none.com.ru\n']));

    await expect(processNextLargeScoreWork(endpoint, 1)).rejects.toThrow(/total count failed/i);

    expect(largeScoreDb.getRows('large_score_jobs')[0]).toMatchObject({
      status: 'parsing', total_domains: 0,
    });
  });

  it.each([
    ['an already empty queue', []],
    ['a fully excluded final chunk', [
      { id: 11, job_id: 'job-completion-error', domain: 'blocked.com', status: 'pending' },
    ]],
  ])('fails closed when completion cannot be persisted for %s', async (_caseName, domains) => {
    largeScoreDb = createMockSupabase({
      tables: {
        large_score_jobs: [{
          id: 'job-completion-error', client_user_id: mailganerClientId, s3_key: 'input.txt',
          source_filename: 'domains.txt', status: 'scoring', parse_offset: 1,
          parsed_domains: 1, junk_domains: 0, scored_domains: 0, active_domains: 0,
          cached_domains: 0, excluded_domains: 0,
        }],
        large_score_domains: domains,
      },
      errorUpdates: {
        large_score_jobs: { message: 'completion write failed', patchIncludes: { status: 'completed' } },
      },
    });
    const log = jest.fn();

    await expect(processNextLargeScoreWork(endpoint, 1, log)).rejects.toThrow(/completion write failed/i);

    expect(largeScoreDb.getRows('large_score_jobs')[0]).toMatchObject({ status: 'scoring' });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('completed'));
  });

  it('removes old pending exclusions before cache/API work and completes an all-excluded chunk', async () => {
    largeScoreDb = createMockSupabase({ tables: {
      large_score_jobs: [{
        id: 'job-drain', client_user_id: mailganerClientId, s3_key: 'input.txt',
        source_filename: 'domains.txt', status: 'scoring', parse_offset: 2,
        parsed_domains: 2, junk_domains: 0, scored_domains: 0, active_domains: 0,
        cached_domains: 0, excluded_domains: 9,
      }],
      large_score_domains: [
        { id: 1, job_id: 'job-drain', domain: 'one.com', status: 'pending' },
        { id: 2, job_id: 'job-drain', domain: 'two.com', status: 'pending' },
      ],
      mailganer_domain_scores: [], client_pipeline_domain_snapshots: [],
    } });

    await expect(processNextLargeScoreWork(endpoint, 2)).resolves.toBe(true);

    expect(largeScoreDb.getRows('large_score_domains')).toEqual([
      expect.objectContaining({ id: 1, status: 'excluded' }),
      expect.objectContaining({ id: 2, status: 'excluded' }),
    ]);
    // The real migration increments this atomically; the engine only owns status.
    expect(largeScoreDb.getRows('large_score_jobs')[0]).toMatchObject({
      status: 'completed', excluded_domains: 9, scored_domains: 0, active_domains: 0,
    });
    expect(largeScoreDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);
    expect(getCachedScoresMock).not.toHaveBeenCalled();
    expect(getOrFetchScoreMock).not.toHaveBeenCalled();

    largeScoreDb = createMockSupabase({ tables: {
      large_score_jobs: [{
        id: 'job-other-client', client_user_id: 'client-2', s3_key: 'input.txt',
        source_filename: 'domains.txt', status: 'scoring', parse_offset: 1,
        parsed_domains: 1, junk_domains: 0, scored_domains: 0, active_domains: 0,
        cached_domains: 0, excluded_domains: 0,
      }],
      large_score_domains: [
        { id: 3, job_id: 'job-other-client', domain: 'allowed.com', status: 'pending' },
      ],
      mailganer_domain_scores: [{ domain: 'allowed.com', company_name: null }],
      client_pipeline_domain_snapshots: [],
    } });

    await expect(processNextLargeScoreWork(endpoint, 1)).resolves.toBe(true);
    expect(getCachedScoresMock).toHaveBeenLastCalledWith(['allowed.com']);
    expect(largeScoreDb.getRows('large_score_domains')[0]).toMatchObject({ status: 'scored' });
    expect(largeScoreDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(1);
  });
});
