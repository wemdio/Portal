/** @jest-environment node */

type DbResponse = { data: unknown; error: null };
type JobsBuilder = {
  select: jest.Mock;
  update: jest.Mock;
  eq: jest.Mock;
  in: jest.Mock;
  single: jest.Mock;
  maybeSingle: jest.Mock;
  then: (
    resolve?: (value: DbResponse) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

const mockUpdates: Array<Record<string, unknown>> = [];
let snapshotRpcMode: 'empty' | 'error' = 'empty';
let snapshotRpcCalls = 0;
const mockTrace = {
  end: jest.fn(async () => {}),
  fail: jest.fn(async () => {}),
};

const mockJob = {
  id: 'job-676',
  user_id: 'user-1',
  status: 'running',
  extraction_type: 'email',
  total: 676,
  processed: 0,
  success_count: 0,
  error_count: 0,
  spreadsheet_tab_id: null,
  result_col_index: null,
  result_col_header: null,
  result_col_index_2: null,
  result_col_header_2: null,
  extractors: null,
  extra_cols: null,
};

function makeJobsBuilder() {
  let projection = '';
  let patch: Record<string, unknown> | null = null;
  let mutationRecorded = false;

  const response = (): DbResponse => {
    if (patch) {
      if (!mutationRecorded) {
        mockUpdates.push(patch);
        mutationRecorded = true;
      }
      return { data: [], error: null };
    }
    if (projection === 'status') {
      if (snapshotRpcMode === 'error' && snapshotRpcCalls >= 25) {
        return { data: { status: 'failed' }, error: null };
      }
      return { data: { status: 'running' }, error: null };
    }
    return { data: mockJob, error: null };
  };

  const builder = {} as JobsBuilder;
  builder.select = jest.fn((columns: string) => {
    projection = columns;
    return builder;
  });
  builder.update = jest.fn((value: Record<string, unknown>) => {
    patch = value;
    return builder;
  });
  builder.eq = jest.fn(() => builder);
  builder.in = jest.fn(() => builder);
  builder.single = jest.fn(async () => response());
  builder.maybeSingle = jest.fn(async () => response());
  builder.then = (resolve, reject) => Promise.resolve(response()).then(resolve, reject);
  return builder;
}

const mockDb = {
  from: jest.fn((table: string) => {
    if (table !== 'website_enrichment_jobs') {
      throw new Error(`Unexpected table: ${table}`);
    }
    return makeJobsBuilder();
  }),
  rpc: jest.fn((name: string) => {
    if (name === 'get_website_enrichment_queue_counts') {
      snapshotRpcCalls += 1;
      return {
        maybeSingle: jest.fn(async () => (
          snapshotRpcMode === 'error'
            ? { data: null, error: { message: 'snapshot RPC unavailable' } }
            : {
                data: { pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0, total: 0 },
                error: null,
              }
        )),
      };
    }
    if (name === 'claim_website_enrichment_items') {
      return Promise.resolve({ data: [], error: null });
    }
    if (name === 'reset_stale_website_enrichment_items') {
      return Promise.resolve({ data: 0, error: null });
    }
    throw new Error(`Unexpected RPC: ${name}`);
  }),
};

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));
jest.mock('@/lib/loggerServer', () => ({
  logError: jest.fn(async () => {}),
  logInfo: jest.fn(async () => {}),
}));
jest.mock('@/lib/tracer', () => ({ startTrace: jest.fn(async () => mockTrace) }));
jest.mock('@/lib/enrich/websiteParser', () => ({
  extractNormalizedUrls: jest.fn(),
  fetchAndExtract: jest.fn(),
  normalizeUrl: jest.fn((url: string) => url),
}));
jest.mock('@/lib/enrich/emailScraper', () => ({ scrapeEmails: jest.fn() }));
jest.mock('@/lib/enrich/websiteSignalProcessor', () => ({ processSignalsForUrl: jest.fn() }));
jest.mock('@/lib/enrich/timeoutUtils', () => ({
  runWithTimeout: jest.fn(async (operation: PromiseLike<unknown>) => Promise.resolve(operation)),
}));
jest.mock('@/lib/enrich/errorPolicy', () => ({
  shouldRetryEnrichmentItem: jest.fn(() => false),
  shouldUseCachedError: jest.fn(() => false),
}));
jest.mock('@/lib/spreadsheet/applyJobResults', () => ({ applyEnrichmentResults: jest.fn() }));
jest.mock('@/lib/spreadsheet/applySignalJobResults', () => ({ applySignalJobResults: jest.fn() }));
jest.mock('@/lib/enrich/enrichBuffer', () => ({ writeEnrichResult: jest.fn() }));

import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';

describe('website enrichment worker finalization safety', () => {
  beforeEach(() => {
    mockUpdates.length = 0;
    snapshotRpcMode = 'empty';
    snapshotRpcCalls = 0;
    mockTrace.end.mockClear();
    mockTrace.fail.mockClear();
  });

  it('fails an empty 0/N queue instead of marking it completed', async () => {
    await runWebsiteEnrichmentJob(mockJob.id);

    expect(mockUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('0/676'),
      }),
    );
    expect(mockUpdates).not.toContainEqual(expect.objectContaining({ status: 'completed' }));
    expect(mockTrace.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('0/676') }),
    );
  });

  it('fails after repeated queue snapshot errors instead of occupying a worker forever', async () => {
    snapshotRpcMode = 'error';
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      await runWebsiteEnrichmentJob(mockJob.id);
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(snapshotRpcCalls).toBeLessThan(25);
    expect(mockUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('Supabase'),
      }),
    );
    expect(mockUpdates).not.toContainEqual(expect.objectContaining({ status: 'completed' }));
  });
});
