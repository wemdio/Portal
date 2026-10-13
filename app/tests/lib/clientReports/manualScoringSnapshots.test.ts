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
import { getOrFetchScore } from '@/lib/jobs/mailganerScoreCache';

const cleanCompanyNamesMock = cleanCompanyNames as jest.MockedFunction<typeof cleanCompanyNames>;
const appendLeadsMock = appendLeadsToClientCampaign as jest.MockedFunction<typeof appendLeadsToClientCampaign>;
const scoreMock = getOrFetchScore as jest.MockedFunction<typeof getOrFetchScore>;

const endpoint = { url: 'https://score.test', apiKey: '', authScheme: 'Bearer', timeoutMs: 1000 };
const processedRow = {
  domain: 'manual.test', score: 0, rating: 'D', spf: 'v=spf1 -all',
  email: null, emailValidationStatus: null, email2: null,
  email2ValidationStatus: null, bucket: 'storage' as const, errorMessage: null,
  scrapedName: null,
};
const processedAt = '2026-08-06T10:00:00.000Z';

function pendingSeed(count = 3) {
  return createMockSupabase({ tables: {
    client_manual_score_runs: [{
      id: 'manual-run', client_user_id: 'client-1', source_filename: 'retry.csv',
      route_to_instantly: false, is_no_email_retry: true, status: 'processing',
    }],
    client_manual_score_rows: Array.from({ length: count }, (_, index) => ({
      id: index + 1, run_id: 'manual-run', domain: `pending-${index}.test`, bucket: null,
    })),
    client_pipeline_domain_snapshots: [],
  } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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

  it('preserves the explicit retry marker after temporary manual runs are removed', async () => {
    const baseline = seed();
    mockDb = createMockSupabase({ tables: {
      client_manual_score_runs: baseline.getRows('client_manual_score_runs').map((run) => ({
        ...run, is_no_email_retry: true,
      })),
      client_manual_score_rows: baseline.getRows('client_manual_score_rows'),
      client_pipeline_domain_snapshots: [],
    } });

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'completed' });
    await mockDb.from('client_manual_score_runs').delete().eq('id', 'manual-run');
    await mockDb.from('client_manual_score_rows').delete().eq('run_id', 'manual-run');

    expect(mockDb.getRows('client_manual_score_runs')).toHaveLength(0);
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(1);
    expect(mockDb.getRows('client_pipeline_domain_snapshots')[0]).toMatchObject({
      source_kind: 'manual_scoring',
      metadata: expect.objectContaining({ source_filename: 'manual.csv', is_no_email_retry: true }),
    });
    expect(appendLeadsMock).not.toHaveBeenCalled();
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
      accepted: 1, skipped: 1, acceptedIndexes: [1], attemptedIndexes: [0, 1], identityComplete: true,
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

  it('keeps built-in excluded brands out of Instantly in no-email retry mode', async () => {
    const baseline = routeSeed();
    mockDb = createMockSupabase({ tables: {
      client_manual_score_runs: baseline.getRows('client_manual_score_runs').map((run) => ({
        ...run, is_no_email_retry: true,
      })),
      client_manual_score_rows: baseline.getRows('client_manual_score_rows').map((row, index) => ({
        ...row, company_name: index === 0 ? 'Сбер Тест' : null,
      })),
      mailganer_domain_scores: [],
      client_auto_pipeline_configs: baseline.getRows('client_auto_pipeline_configs'),
      client_pipeline_domain_snapshots: [],
    } });
    cleanCompanyNamesMock.mockResolvedValue(['Сбер Тест', 'Two']);
    appendLeadsMock.mockResolvedValue({
      accepted: 1, skipped: 0, acceptedIndexes: [0], attemptedIndexes: [0], identityComplete: true,
    });

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'completed' });
    expect(appendLeadsMock.mock.calls[0][0].leads.map((lead) => lead.email))
      .toEqual(['two@two.test']);
  });

  it('fails closed on a retry run larger than the pageless 100-row limit', async () => {
    mockDb = createMockSupabase({ tables: {
      client_manual_score_runs: [{
        id: 'manual-run', client_user_id: 'client-1', source_filename: 'retry.csv',
        route_to_instantly: true, is_no_email_retry: true, status: 'pending',
      }],
      client_manual_score_rows: Array.from({ length: 101 }, (_, index) => ({
        id: index + 1, run_id: 'manual-run', domain: `domain-${index}.ru`, bucket: null,
      })),
    } });

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: 'No-email retry runs are limited to 100 rows' });
    expect(appendLeadsMock).not.toHaveBeenCalled();
  });

  it('keeps a failed manual append retryable and does not freeze an unrouted snapshot', async () => {
    mockDb = routeSeed();
    cleanCompanyNamesMock.mockResolvedValue(['One', 'Two']);
    appendLeadsMock.mockRejectedValueOnce(new Error('provider timeout'));

    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: 'provider timeout' });
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);

    appendLeadsMock.mockResolvedValueOnce({
      accepted: 2, skipped: 0, acceptedIndexes: [0, 1], attemptedIndexes: [0, 1], identityComplete: true,
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
        attemptedIndexes: [0, 1],
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
      accepted: 1, skipped: 0, acceptedIndexes: [0], attemptedIndexes: [0], identityComplete: true,
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
      .mockResolvedValueOnce({ accepted: 1, skipped: 0, acceptedIndexes: [0], attemptedIndexes: [0], identityComplete: true })
      .mockRejectedValueOnce(Object.assign(new Error('aggregate-only'), {
        partialResult: {
          accepted: 1, skipped: 0, acceptedIndexes: null, attemptedIndexes: [0], identityComplete: false,
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

  it('retries only the same row payload and detects a lost successful response by readback', async () => {
    mockDb = pendingSeed(1);
    const write = jest.fn(async (payload) => {
      if (write.mock.calls.length === 1) {
        throw { status: 502, message: 'An invalid response was received from the upstream server' };
      }
      await mockDb.from('client_manual_score_rows').update(payload).eq('id', 1);
    });
    await persistManualProcessedRow(1, processedRow, processedAt, { write, baseDelayMs: 0 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual(write.mock.calls[0][0]);
    expect(scoreMock).not.toHaveBeenCalled();

    mockDb = pendingSeed(1);
    const committedWrite = jest.fn(async (payload) => {
      await mockDb.from('client_manual_score_rows').update({
        ...payload, processed_at: '2026-08-06T10:00:00+00:00',
      }).eq('id', 1);
      throw { status: 502, message: 'response lost after COMMIT' };
    });
    await persistManualProcessedRow(1, processedRow, processedAt, { write: committedWrite, baseDelayMs: 0 });
    expect(committedWrite).toHaveBeenCalledTimes(1);
  });

  it('bounds transient retries but never retries permissions or overwrites a different saved result', async () => {
    mockDb = pendingSeed(1);
    const transient = jest.fn(async () => { throw { status: 503, message: 'service unavailable' }; });
    await expect(persistManualProcessedRow(1, processedRow, processedAt, {
      write: transient, maxAttempts: 3, baseDelayMs: 0,
    })).rejects.toThrow('service unavailable');
    expect(transient).toHaveBeenCalledTimes(3);

    const permanent = jest.fn(async () => { throw { code: '42501', status: 403, message: 'permission denied' }; });
    await expect(persistManualProcessedRow(1, processedRow, processedAt, {
      write: permanent, baseDelayMs: 0,
    })).rejects.toThrow('permission denied');
    expect(permanent).toHaveBeenCalledTimes(1);

    await mockDb.from('client_manual_score_rows').update({ bucket: 'storage', score: 99, processed_at: processedAt }).eq('id', 1);
    await expect(persistManualProcessedRow(1, processedRow, processedAt, { baseDelayMs: 0 }))
      .rejects.toThrow('different saved result');
    expect(mockDb.getRows('client_manual_score_rows')[0].score).toBe(99);

    const ownership = jest.fn(async () => { throw new Error('network check unavailable'); });
    await expect(persistManualProcessedRow(1, processedRow, processedAt, {
      write: transient, assertOwnership: ownership, baseDelayMs: 0,
    })).rejects.toThrow('ownership is unavailable');
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(transient).toHaveBeenCalledTimes(3);

    // A readback body that never resolves must not keep the drained pool alive.
    mockDb = pendingSeed(1);
    const never = new Promise(() => undefined);
    const readSpy = jest.spyOn(mockDb, 'from').mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => never }) }),
    }) as never);
    jest.useFakeTimers();
    try {
      const saved = persistManualProcessedRow(1, processedRow, processedAt, {
        write: transient, maxAttempts: 1, baseDelayMs: 0,
      });
      const rejected = expect(saved).rejects.toMatchObject({ cause: { code: 'ETIMEDOUT' } });
      await jest.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(transient).toHaveBeenCalledTimes(4);
    } finally {
      readSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('drains in-flight rows before failing and never assigns another row after a fatal save', async () => {
    mockDb = pendingSeed();
    let stopping = false;
    const inFlight = deferred<Awaited<ReturnType<typeof getOrFetchScore>>>();
    const failedWrite = deferred<void>();
    scoreMock.mockResolvedValueOnce({ score: 0, spf: null, raw: null, ok: true })
      .mockImplementationOnce(() => inFlight.promise);
    const write = jest.fn(async (rowId, payload) => {
      if (rowId === 1) {
        stopping = true; // A simultaneous SIGTERM must not hide a real failure.
        failedWrite.resolve();
        throw { code: '42501', message: 'permission denied' };
      }
      await mockDb.from('client_manual_score_rows').update(payload).eq('id', rowId);
    });
    const run = processManualRun({
      runId: 'manual-run', endpoint, concurrency: 2, persistRow: write, shouldStop: () => stopping,
    });
    await failedWrite.promise;
    expect(mockDb.getRows('client_manual_score_runs')[0].status).toBe('processing');
    expect(appendLeadsMock).not.toHaveBeenCalled();
    inFlight.resolve({ score: 0, spf: null, raw: null, ok: true });
    await expect(run).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('permission denied') });
    expect(scoreMock).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([rowId]) => rowId)).toEqual([1, 2]);
    expect(mockDb.getRows('client_manual_score_rows')[2].bucket).toBeNull();
    expect(mockDb.mutations.at(-1)).toMatchObject({
      kind: 'update', table: 'client_manual_score_runs', patch: { status: 'failed' },
    });
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);
  });

  it('checkpoints after draining a shutdown row without routing or mutating the claimed run', async () => {
    mockDb = pendingSeed();
    let stopping = false;
    scoreMock.mockImplementationOnce(async () => {
      stopping = true;
      return { score: 0, spf: null, raw: null, ok: true };
    });
    const beforeReconcile = jest.fn(async () => undefined);
    const updateRunState = jest.fn(async () => undefined);
    await expect(processManualRun({
      runId: 'manual-run', endpoint, concurrency: 1, skipMarkProcessing: true,
      shouldStop: () => stopping, updateRunState, beforeReconcile,
    })).resolves.toMatchObject({ status: 'paused', total: 1 });
    expect(scoreMock).toHaveBeenCalledTimes(1);
    expect(mockDb.getRows('client_manual_score_rows').map((row) => row.bucket))
      .toEqual(['storage', null, null]);
    expect(beforeReconcile).not.toHaveBeenCalled();
    expect(updateRunState).not.toHaveBeenCalled();
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toHaveLength(0);
    expect(appendLeadsMock).not.toHaveBeenCalled();
  });

  it('finishes already-started routing and its receipts when shutdown arrives during provider append', async () => {
    mockDb = routeSeed();
    let stopping = false;
    cleanCompanyNamesMock.mockResolvedValue(['One', 'Two']);
    const beforeReconcile = jest.fn(async () => undefined);
    appendLeadsMock.mockImplementationOnce(async () => {
      stopping = true;
      return { accepted: 2, skipped: 0, acceptedIndexes: [0, 1], attemptedIndexes: [0, 1], identityComplete: true };
    });
    await expect(processManualRun({
      runId: 'manual-run', endpoint, beforeReconcile, shouldStop: () => stopping,
    })).resolves.toMatchObject({ status: 'completed' });
    expect(beforeReconcile).toHaveBeenCalledTimes(1);
    expect(appendLeadsMock).toHaveBeenCalledTimes(1);
    expect(mockDb.getRows('client_pipeline_domain_snapshots')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_row_id: '7', routed_campaign_id: 'campaign-b' }),
      expect.objectContaining({ source_row_id: '8', routed_campaign_id: 'campaign-b' }),
    ]));
  });

  it('refuses completion on an unreadable final row count or an unprocessed row appearing before finalization', async () => {
    const baseline = seed();
    mockDb = createMockSupabase({ tables: {
      client_manual_score_runs: baseline.getRows('client_manual_score_runs'),
      client_manual_score_rows: baseline.getRows('client_manual_score_rows'),
      client_pipeline_domain_snapshots: [],
    }, errorSelects: {
      client_manual_score_rows: { columnsInclude: 'bucket, email', message: 'completion query unavailable' },
    } });
    await expect(processManualRun({ runId: 'manual-run', endpoint }))
      .resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('completion query unavailable') });

    mockDb = seed();
    await expect(processManualRun({
      runId: 'manual-run', endpoint,
      beforeReconcile: async () => {
        await mockDb.from('client_manual_score_rows').insert({
          id: 8, run_id: 'manual-run', domain: 'unprocessed.test', bucket: null,
          processed_at: null, score: null,
        });
      },
    })).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('unprocessed rows') });
  });
});
