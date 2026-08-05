/** @jest-environment node */

/**
 * Tests for POST /api/client/eng/verticals/[id]/chain.
 *
 *   201 -> { ok, job } — chain generation enqueued; default language comes from
 *          the us market of the project ('en'), explicit { language } wins.
 *   200 -> dedup: an active chain job for this vertical already exists.
 *   400 -> unknown language.
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

import { POST } from '@/app/api/client/eng/verticals/[id]/chain/route';

function makeReq(body?: unknown): NextRequest {
  return new Request('http://x/api/client/eng/verticals/v1/chain', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'v1' }) };

function seed(createdBy: string = USER_ID, jobs: Array<Record<string, unknown>> = []) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researched', market: 'us' },
      ],
      he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      he_jobs: jobs,
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('POST /api/client/eng/verticals/[id]/chain', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('defaults the chain language to en for a us-market project', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { ok: boolean; job: { payload: { vertical_id: string; language: string } } };
    expect(body.ok).toBe(true);
    expect(body.job.payload).toEqual({ vertical_id: 'v1', language: 'en' });
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('honours an explicit language', async () => {
    const res = await POST(makeReq({ language: 'pl' }), params);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { payload: { language: string } } };
    expect(body.job.payload.language).toBe('pl');
  });

  it('returns 400 for an unknown language', async () => {
    const res = await POST(makeReq({ language: 'de' }), params);
    expect(res.status).toBe(400);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('returns the existing active chain job on a duplicate launch', async () => {
    seed(USER_ID, [
      { id: 'j1', project_id: 'p1', stage: 'chain', status: 'running', payload: { vertical_id: 'v1', language: 'en' } },
    ]);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string } };
    expect(body.job.id).toBe('j1');
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('returns 404 for a foreign vertical and enqueues nothing', async () => {
    seed(OTHER_USER_ID);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});
