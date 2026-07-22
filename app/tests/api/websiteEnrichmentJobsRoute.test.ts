/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000001';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: USER_ID } } })),
    },
  }),
}));

function makeRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    rowIndex: index,
    url: `https://company-${index}.example`,
  }));
}

function makePostRequest(count = 2): NextRequest {
  return new Request('http://x/api/enrich/website/jobs', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ rows: makeRows(count), extraction_type: 'email' }),
  }) as unknown as NextRequest;
}

async function post(count = 2) {
  const { POST } = await import('@/app/api/enrich/website/jobs/route');
  return POST(makePostRequest(count));
}

beforeEach(() => {
  jest.resetModules();
  mockDb = createMockSupabase({
    tables: {
      website_enrichment_jobs: [],
      website_enrichment_queue: [],
    },
  });
});

describe('POST /api/enrich/website/jobs', () => {
  it('publishes the job only after every queue batch is inserted', async () => {
    const response = await post(501);

    expect(response.status).toBe(200);

    const jobInsert = mockDb.inserts.find((call) => call.table === 'website_enrichment_jobs');
    expect(jobInsert?.rows[0]).toEqual(expect.objectContaining({ status: 'preparing', total: 501 }));

    const queueInserts = mockDb.inserts.filter((call) => call.table === 'website_enrichment_queue');
    expect(queueInserts.map((call) => call.rows.length)).toEqual([500, 1]);
    expect(
      mockDb.mutations.map((mutation) => {
        if (mutation.kind === 'insert') return `${mutation.table}:insert:${mutation.rows.length}`;
        if (mutation.kind === 'update') {
          if (mutation.patch.preparing_heartbeat_at) {
            return `${mutation.table}:update:heartbeat`;
          }
          return `${mutation.table}:update:${String(mutation.patch.status)}`;
        }
        return `${mutation.table}:${mutation.kind}`;
      }),
    ).toEqual([
      'website_enrichment_jobs:insert:1',
      'website_enrichment_queue:insert:500',
      'website_enrichment_jobs:update:heartbeat',
      'website_enrichment_queue:insert:1',
      'website_enrichment_jobs:update:heartbeat',
      'website_enrichment_jobs:update:pending',
    ]);
    expect(mockDb.getRows('website_enrichment_queue')).toHaveLength(501);
    expect(mockDb.getRows('website_enrichment_jobs')[0]).toEqual(
      expect.objectContaining({ status: 'pending', total: 501 }),
    );
  });

  it('marks the staged job failed when queue insertion fails', async () => {
    mockDb = createMockSupabase({
      tables: {
        website_enrichment_jobs: [],
        website_enrichment_queue: [],
      },
      errorTables: { website_enrichment_queue: 'queue insert failed' },
    });

    const response = await post();

    expect(response.status).toBe(500);
    expect(mockDb.getRows('website_enrichment_jobs')[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('queue insert failed'),
        completed_at: expect.any(String),
      }),
    );
  });

  it('does not publish a partially written queue when a later batch fails', async () => {
    const workingFrom = mockDb.from;
    const failingDb = createMockSupabase({
      tables: { website_enrichment_queue: [] },
      errorTables: { website_enrichment_queue: 'second queue batch failed' },
    });
    let queueInsertCalls = 0;
    mockDb.from = ((table: string) => {
      const builder = workingFrom(table);
      if (table !== 'website_enrichment_queue') return builder;

      const insert = builder.insert;
      builder.insert = (rows) => {
        queueInsertCalls += 1;
        return queueInsertCalls === 2
          ? failingDb.from(table).insert(rows)
          : insert(rows);
      };
      return builder;
    }) as MockSupabaseClient['from'];

    const response = await post(501);

    expect(response.status).toBe(500);
    expect(mockDb.getRows('website_enrichment_queue')).toHaveLength(500);
    expect(mockDb.getRows('website_enrichment_jobs')[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('second queue batch failed'),
      }),
    );
    expect(
      mockDb.mutations.some(
        (mutation) => mutation.kind === 'update' && mutation.patch.status === 'pending',
      ),
    ).toBe(false);
  });

  it('blocks a second launch while the first job is still preparing its queue', async () => {
    mockDb = createMockSupabase({
      tables: {
        website_enrichment_jobs: [
          {
            id: 'preparing-job',
            user_id: USER_ID,
            status: 'preparing',
            extraction_type: 'email',
            total: 676,
            processed: 0,
            created_at: '2026-07-22T04:39:11.196Z',
          },
        ],
        website_enrichment_queue: [],
      },
    });

    const response = await post();

    expect(response.status).toBe(409);
    expect(mockDb.getRows('website_enrichment_jobs')).toHaveLength(1);
  });
});
