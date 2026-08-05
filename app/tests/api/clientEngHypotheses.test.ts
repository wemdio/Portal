/** @jest-environment node */

/**
 * Tests for PATCH /api/client/eng/hypotheses/[id].
 *
 *   { verdict: 'accept' | 'reject' }
 *   200 -> { hypothesis, verticals } — status persisted ('accepted'/'rejected'),
 *          project verticals recomputed (same reviewRecompute as staff).
 *   400 -> missing / unknown verdict.
 *   404 -> foreign / missing hypothesis (scoped via the parent project).
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

import { PATCH } from '@/app/api/client/eng/hypotheses/[id]/route';

function makeReq(body: unknown): NextRequest {
  return new Request('http://x/api/client/eng/hypotheses/h1', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'h1' }) };

function seed(createdBy: string = USER_ID) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researched', market: 'us' },
      ],
      he_hypotheses: [
        { id: 'h1', project_id: 'p1', tier: 1, title: 'Banks', status: 'proposed', potential_pct: 40 },
      ],
      he_verticals: [],
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('PATCH /api/client/eng/hypotheses/[id] — validation', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await PATCH(makeReq({ verdict: 'accept' }), params);
    expect(res.status).toBe(401);
  });

  it('returns 400 when verdict is missing', async () => {
    const res = await PATCH(makeReq({}), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown verdict', async () => {
    const res = await PATCH(makeReq({ verdict: 'maybe' }), params);
    expect(res.status).toBe(400);
    expect(mockDb.getRows('he_hypotheses')[0].status).toBe('proposed');
  });
});

describe('PATCH /api/client/eng/hypotheses/[id] — happy path', () => {
  it('verdict accept -> status accepted', async () => {
    const res = await PATCH(makeReq({ verdict: 'accept' }), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { hypothesis: { id: string; status: string } };
    expect(body.hypothesis.id).toBe('h1');
    expect(mockDb.getRows('he_hypotheses')[0].status).toBe('accepted');
  });

  it('verdict reject -> status rejected', async () => {
    const res = await PATCH(makeReq({ verdict: 'reject' }), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_hypotheses')[0].status).toBe('rejected');
  });
});

describe('PATCH /api/client/eng/hypotheses/[id] — scope', () => {
  it('returns 404 for a hypothesis of a foreign project and does not touch it', async () => {
    seed(OTHER_USER_ID);
    const res = await PATCH(makeReq({ verdict: 'accept' }), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_hypotheses')[0].status).toBe('proposed');
  });
});
