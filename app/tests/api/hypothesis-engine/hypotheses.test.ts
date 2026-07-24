/** @jest-environment node */

/**
 * Tests for PATCH /api/tools/hypothesis-engine/hypotheses/[id].
 *
 *   200 -> { hypothesis } with the new status persisted.
 *   400 -> { error } for missing / unknown status.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000001';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'admin' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { PATCH } from '@/app/api/tools/hypothesis-engine/hypotheses/[id]/route';

function makeReq(body: unknown): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/hypotheses/h1', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'h1' }) };

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      he_hypotheses: [
        { id: 'h1', project_id: 'p1', tier: 1, title: 'Банки', status: 'proposed', potential_pct: 40 },
      ],
    },
  });
});

describe('PATCH hypotheses — validation', () => {
  it('returns 400 when status is missing', async () => {
    const res = await PATCH(makeReq({}), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown status', async () => {
    const res = await PATCH(makeReq({ status: 'maybe' }), params);
    expect(res.status).toBe(400);
    expect(mockDb.getRows('he_hypotheses')[0].status).toBe('proposed');
  });

  it('returns 400 for a non-string status', async () => {
    const res = await PATCH(makeReq({ status: 42 }), params);
    expect(res.status).toBe(400);
  });
});

describe('PATCH hypotheses — happy path', () => {
  it.each(['accepted', 'rejected', 'proposed'] as const)('sets status to %s', async (status) => {
    const res = await PATCH(makeReq({ status }), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { hypothesis: { id: string } };
    expect(body.hypothesis.id).toBe('h1');
    expect(mockDb.getRows('he_hypotheses')[0].status).toBe(status);
  });
});
