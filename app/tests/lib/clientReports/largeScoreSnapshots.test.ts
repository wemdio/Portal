/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;
const mockGetCachedScores = jest.fn();
const mockGetOrFetchScore = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));
jest.mock('@/lib/mainS3Server', () => ({ getMainS3ObjectStream: jest.fn() }));
jest.mock('@/lib/jobs/mailganerScoreCache', () => ({
  getCachedScores: (...args: unknown[]) => mockGetCachedScores(...args),
  getOrFetchScore: (...args: unknown[]) => mockGetOrFetchScore(...args),
  normalizeDomain: (value: string) => value.trim().toLowerCase() || null,
  emptyCacheStats: () => ({ hits: 0, misses: 0, errors: 0 }),
}));

import { processNextLargeScoreWork } from '@/lib/jobs/largeScoreEngine';

const endpoint = { url: 'https://score.test', apiKey: '', authScheme: 'Bearer', timeoutMs: 1000 };

function seed(errorSnapshots = false) {
  return createMockSupabase({
    tables: {
      large_score_jobs: [{
        id: 'job-1', client_user_id: 'client-1', s3_key: 'input.txt',
        source_filename: 'million.txt', status: 'scoring',
        parse_offset: 1, parsed_domains: 1, junk_domains: 0, scored_domains: 0,
        active_domains: 0, cached_domains: 0,
      }],
      large_score_domains: [{ id: 9, job_id: 'job-1', domain: 'Example.com', status: 'pending' }],
      mailganer_domain_scores: [{ domain: 'example.com', company_name: null }],
      client_pipeline_domain_snapshots: [],
    },
    errorTables: errorSnapshots
      ? { client_pipeline_domain_snapshots: 'snapshot database unavailable' }
      : undefined,
  });
}

describe('large-score durable snapshot integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedScores.mockResolvedValue(new Map([['example.com', {
      ok: true, score: 42_000, spf: 'v=spf1 -all', raw: { rating: 'B' },
    }]]));
  });

  it('persists the client/job/row snapshot before marking the source row scored', async () => {
    mockDb = seed();

    await expect(processNextLargeScoreWork(endpoint, 1)).resolves.toBe(true);

    expect(mockDb.getRows('client_pipeline_domain_snapshots')[0]).toMatchObject({
      client_user_id: 'client-1', source_kind: 'large_score_file',
      source_job_id: 'job-1', source_row_id: '9', domain: 'example.com',
      score: 42_000, score_code: 'B', rating: 'B', score_origin: 'cache',
      metadata: expect.objectContaining({ source_filename: 'million.txt' }),
    });
    expect(mockDb.getRows('large_score_domains')[0]).toMatchObject({ status: 'scored' });

    const snapshotWrite = mockDb.mutations.findIndex(
      (mutation) => mutation.kind === 'upsert' && mutation.table === 'client_pipeline_domain_snapshots',
    );
    const sourceMark = mockDb.mutations.findIndex(
      (mutation) => mutation.kind === 'update' && mutation.table === 'large_score_domains',
    );
    expect(snapshotWrite).toBeGreaterThanOrEqual(0);
    expect(sourceMark).toBeGreaterThan(snapshotWrite);
  });

  it('leaves the source row pending if durable persistence fails', async () => {
    mockDb = seed(true);

    await expect(processNextLargeScoreWork(endpoint, 1))
      .rejects.toThrow('snapshot database unavailable');
    expect(mockDb.getRows('large_score_domains')[0]).toMatchObject({ status: 'pending' });
  });
});
