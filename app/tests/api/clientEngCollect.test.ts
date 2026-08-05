/** @jest-environment node */

/**
 * Tests for POST /api/client/eng/verticals/[id]/collect.
 *
 *   201 -> { ok, base } — auto-collect enqueued (he_bases collecting + base_collect
 *          job); cabinet default limit is 2000, allowed: 2000 | 10000.
 *   200 -> { ok, existing: true, base } — dedup: a collecting base already exists.
 *   400 -> unsupported limit / malformed hypothesis_ids.
 *   404 -> foreign / missing vertical.
 *   401 -> unauthenticated.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockAuthResult: unknown;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/clientApiHelper', () => ({
  jsonError: (message: string, status: number) =>
    NextResponse.json({ error: message }, { status }),
  requireClientAuth: jest.fn(async () => mockAuthResult),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/client/eng/verticals/[id]/collect/route';

function makeReq(body?: unknown): NextRequest {
  return new Request('http://x/api/client/eng/verticals/v1/collect', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'v1' }) };

function seed(
  createdBy: string = USER_ID,
  bases: Array<Record<string, unknown>> = [],
  jobs: Array<Record<string, unknown>> = [],
) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researched', market: 'us' },
      ],
      he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      he_bases: bases,
      he_jobs: jobs,
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('POST /api/client/eng/verticals/[id]/collect — validation', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('returns 400 for the staff-only 50000 limit', async () => {
    const res = await POST(makeReq({ limit: 50000 }), params);
    expect(res.status).toBe(400);
    expect(mockDb.getRows('he_bases')).toHaveLength(0);
  });

  it('returns 400 for malformed hypothesis_ids', async () => {
    const res = await POST(makeReq({ hypothesis_ids: ['ok', ''] }), params);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/client/eng/verticals/[id]/collect — happy path', () => {
  it('defaults the collect limit to 2000 for the cabinet', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { ok: boolean; base: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.base.status).toBe('collecting');

    const bases = mockDb.getRows('he_bases');
    expect(bases).toHaveLength(1);
    expect(bases[0]).toEqual(
      expect.objectContaining({
        project_id: 'p1',
        vertical_id: 'v1',
        source: 'auto',
        status: 'collecting',
        collect_info: { limit: 2000 },
      }),
    );

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        stage: 'base_collect',
        payload: { base_id: body.base.id, limit: 2000 },
      }),
    );
  });

  it('accepts an explicit limit 10000 and hypothesis selection', async () => {
    const res = await POST(makeReq({ limit: 10000, hypothesis_ids: ['h1', 'h2'] }), params);
    expect(res.status).toBe(201);

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ limit: 10000, hypothesis_ids: ['h1', 'h2'] }),
      }),
    );
  });
});

describe('POST /api/client/eng/verticals/[id]/collect — dedup & scope', () => {
  it('returns 200 + existing when a collecting base already exists', async () => {
    seed(USER_ID, [
      { id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'collecting', collect_info: { limit: 2000 } },
    ]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { existing: boolean; base: { id: string } };
    expect(body.existing).toBe(true);
    expect(body.base.id).toBe('b1');
    expect(mockDb.getRows('he_bases')).toHaveLength(1);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('returns 404 for a foreign vertical and creates nothing', async () => {
    seed(OTHER_USER_ID);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_bases')).toHaveLength(0);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});
