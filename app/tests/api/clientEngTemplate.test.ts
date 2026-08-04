/** @jest-environment node */

/**
 * Tests for POST /api/client/eng/bases/[id]/template.
 *
 *   201 -> { ok, job } — 85/15 template generation enqueued (stage 'template').
 *   200 -> dedup: an active template job for this base already exists.
 *   409 -> base is not analyzed yet.
 *   404 -> foreign / missing base.
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

import { POST } from '@/app/api/client/eng/bases/[id]/template/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/client/eng/bases/b1/template', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'b1' }) };

function seed(
  createdBy: string = USER_ID,
  baseStatus: string = 'analyzed',
  jobs: Array<Record<string, unknown>> = [],
) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researched', market: 'us' },
      ],
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', status: baseStatus }],
      he_jobs: jobs,
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('POST /api/client/eng/bases/[id]/template', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('enqueues a template job for an analyzed base', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { ok: boolean; job: { stage: string; payload: { base_id: string } } };
    expect(body.ok).toBe(true);
    expect(body.job.stage).toBe('template');
    expect(body.job.payload.base_id).toBe('b1');
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('returns 409 when the base is not analyzed yet', async () => {
    seed(USER_ID, 'collecting');
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('returns the existing active template job on a duplicate launch', async () => {
    seed(USER_ID, 'analyzed', [
      { id: 'j1', project_id: 'p1', stage: 'template', status: 'pending', payload: { base_id: 'b1' } },
    ]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string } };
    expect(body.job.id).toBe('j1');
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('returns 404 for a foreign base and enqueues nothing', async () => {
    seed(OTHER_USER_ID);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});
