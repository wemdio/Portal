/** @jest-environment node */

/**
 * Tests for PATCH /api/client/eng/chains/[id].
 *
 *   { letters: [...] } — full replacement of the chain letters (inline editor):
 *   200 -> { letters } normalized (first wait_days=0, others clamped 0..90).
 *   400 -> invalid letters (empty body, too many letters, …).
 *   404 -> foreign / missing chain (scoped via vertical → project).
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

import { PATCH } from '@/app/api/client/eng/chains/[id]/route';

function makeReq(body: unknown): NextRequest {
  return new Request('http://x/api/client/eng/chains/c1', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'c1' }) };

const EXISTING_LETTERS = [
  { subject: 'Hello', body: 'First letter', wait_days: 0 },
  { subject: null, body: 'Follow-up', wait_days: 3 },
];

function seed(createdBy: string = USER_ID) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researched', market: 'us' },
      ],
      he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      he_chains: [{ id: 'c1', vertical_id: 'v1', language: 'en', letters: EXISTING_LETTERS }],
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('PATCH /api/client/eng/chains/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await PATCH(makeReq({ letters: [{ body: 'x' }] }), params);
    expect(res.status).toBe(401);
  });

  it('replaces letters with normalization (wait_days clamped, first = 0)', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          { subject: 'Hi', body: 'Edited first', wait_days: 5 },
          { subject: null, body: 'Edited second', wait_days: 120 },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: Array<{ wait_days: number; body: string }> };
    expect(body.letters).toEqual([
      { subject: 'Hi', body: 'Edited first', wait_days: 0 },
      { subject: null, body: 'Edited second', wait_days: 90 },
    ]);
    expect(mockDb.getRows('he_chains')[0].letters).toEqual(body.letters);
  });

  it('returns 400 for an empty letter body', async () => {
    const res = await PATCH(makeReq({ letters: [{ subject: 'Hi', body: '  ' }] }), params);
    expect(res.status).toBe(400);
    expect(mockDb.updates).toHaveLength(0);
  });

  it('returns 400 when letters is not an array', async () => {
    const res = await PATCH(makeReq({ letters: 'nope' }), params);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a chain of a foreign project and does not touch it', async () => {
    seed(OTHER_USER_ID);
    const res = await PATCH(makeReq({ letters: [{ body: 'hacked' }] }), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_chains')[0].letters).toEqual(EXISTING_LETTERS);
  });
});
