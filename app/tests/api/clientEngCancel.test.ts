/** @jest-environment node */

/**
 * Tests for POST /api/client/eng/projects/[id]/cancel.
 *
 *   200 -> { ok, cancelled } — active jobs cancelled; collecting/analyzing
 *          bases flipped to failed; a researching project back to draft.
 *   409 -> no active jobs.
 *   404 -> foreign / missing project.
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

import { POST } from '@/app/api/client/eng/projects/[id]/cancel/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/client/eng/projects/p1/cancel', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

function seed(createdBy: string = USER_ID, jobs: Array<Record<string, unknown>> = []) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researching', market: 'us' },
      ],
      he_jobs: jobs,
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', status: 'collecting' }],
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed(USER_ID, [
    { id: 'j1', project_id: 'p1', stage: 'site_profile', status: 'running', payload: {} },
    { id: 'j2', project_id: 'p1', stage: 'chain', status: 'done', payload: {} },
  ]);
});

describe('POST /api/client/eng/projects/[id]/cancel', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('cancels active jobs, fails collecting bases and reverts the project to draft', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; cancelled: number };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(1);

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs.find((j) => j.id === 'j1')).toEqual(expect.objectContaining({ status: 'cancelled' }));
    expect(jobs.find((j) => j.id === 'j2')).toEqual(expect.objectContaining({ status: 'done' }));

    expect(mockDb.getRows('he_bases')[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(mockDb.getRows('he_projects')[0]).toEqual(expect.objectContaining({ status: 'draft', error: null }));
  });

  it('returns 409 when there is nothing to cancel', async () => {
    seed(USER_ID, [{ id: 'j2', project_id: 'p1', stage: 'chain', status: 'done', payload: {} }]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
  });

  it('returns 404 for a foreign project and cancels nothing', async () => {
    seed(OTHER_USER_ID, [{ id: 'j1', project_id: 'p1', stage: 'site_profile', status: 'running', payload: {} }]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_jobs')[0]).toEqual(expect.objectContaining({ status: 'running' }));
  });
});
