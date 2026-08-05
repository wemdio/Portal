/** @jest-environment node */

/**
 * Tests for POST /api/client/eng/projects/[id]/research.
 *
 *   200 -> { ok, job } — site_profile enqueued, project flipped to 'researching'.
 *   409 -> an active research-stage job already exists (dedup).
 *   404 -> foreign / missing project (existence is not leaked).
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

import { POST } from '@/app/api/client/eng/projects/[id]/research/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/client/eng/projects/p1/research', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

function seed(createdBy: string = USER_ID, jobs: Array<Record<string, unknown>> = []) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        {
          id: 'p1',
          created_by: createdBy,
          name: 'Mine',
          website_url: 'https://mine.example/',
          status: 'draft',
          market: 'us',
        },
      ],
      he_jobs: jobs,
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('POST /api/client/eng/projects/[id]/research', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('enqueues site_profile and marks the project researching', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; job: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.job.stage).toBe('site_profile');

    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
    expect(mockDb.getRows('he_projects')[0]).toEqual(
      expect.objectContaining({ status: 'researching', error: null }),
    );
  });

  it('returns 409 when a research-stage job is already active', async () => {
    seed(USER_ID, [{ id: 'j1', project_id: 'p1', stage: 'evidence', status: 'running', payload: {} }]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('allows a rerun when previous jobs are done/failed', async () => {
    seed(USER_ID, [{ id: 'j1', project_id: 'p1', stage: 'clustering', status: 'failed', payload: {} }]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });

  it('returns 404 for a foreign project and enqueues nothing', async () => {
    seed(OTHER_USER_ID);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});
