/** @jest-environment node */

/**
 * Tests for POST /api/tools/hypothesis-engine/projects/[id]/bases.
 *
 *   201 -> { base: { id, status } } — he_bases row + he_jobs(base_analyze).
 *   400 -> { error } for missing vertical_id / columns / rows.
 *   404 -> { error } when the vertical does not belong to the project.
 *   413 -> { error } when rows exceed the 10000 cap.
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

import { POST } from '@/app/api/tools/hypothesis-engine/projects/[id]/bases/route';

const PROJECT_ID = 'p1';
const VERTICAL_ID = 'v1';

function makeReq(body: unknown): NextRequest {
  return new Request(`http://x/api/tools/hypothesis-engine/projects/${PROJECT_ID}/bases`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: PROJECT_ID }) };

function seedProjectAndVertical() {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [{ id: PROJECT_ID, name: 'P', website_url: 'https://x.example/', status: 'researched' }],
      he_verticals: [{ id: VERTICAL_ID, project_id: PROJECT_ID, name: 'Banks' }],
      he_bases: [],
      he_jobs: [],
    },
  });
}

describe('POST bases — validation', () => {
  beforeEach(seedProjectAndVertical);

  it('returns 400 when vertical_id is missing', async () => {
    const res = await POST(makeReq({ columns: ['email'], rows: [{ email: 'a@b.c' }] }), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 when columns is empty', async () => {
    const res = await POST(makeReq({ vertical_id: VERTICAL_ID, columns: [], rows: [{ a: 1 }] }), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 when rows is empty', async () => {
    const res = await POST(makeReq({ vertical_id: VERTICAL_ID, columns: ['email'], rows: [] }), params);
    expect(res.status).toBe(400);
  });

  it('returns 413 when rows exceed the 10000 cap', async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({ email: `u${i}@x.example` }));
    const res = await POST(
      makeReq({ vertical_id: VERTICAL_ID, columns: ['email'], rows }),
      params,
    );
    expect(res.status).toBe(413);
    // Nothing persisted.
    expect(mockDb.getRows('he_bases')).toHaveLength(0);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('returns 404 when the vertical belongs to another project', async () => {
    const res = await POST(
      makeReq({ vertical_id: 'other-project-vertical', columns: ['email'], rows: [{ email: 'a@b.c' }] }),
      params,
    );
    expect(res.status).toBe(404);
  });
});

describe('POST bases — happy path', () => {
  beforeEach(seedProjectAndVertical);

  it('stores the base (sample 30 rows + full data) and enqueues base_analyze', async () => {
    const rows = Array.from({ length: 42 }, (_, i) => ({
      company: `Co ${i}`,
      email: `lead${i}@x.example`,
    }));

    const res = await POST(
      makeReq({ vertical_id: VERTICAL_ID, filename: 'leads.csv', columns: ['company', 'email'], rows }),
      params,
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as { base: { id: string; status: string } };
    expect(body.base.id).toBeTruthy();
    expect(body.base.status).toBe('uploaded');

    const baseRows = mockDb.getRows('he_bases');
    expect(baseRows).toHaveLength(1);
    expect(baseRows[0]).toEqual(
      expect.objectContaining({
        project_id: PROJECT_ID,
        vertical_id: VERTICAL_ID,
        filename: 'leads.csv',
        row_count: 42,
        status: 'uploaded',
      }),
    );
    // sample_rows ограничен 30, data — полный массив.
    expect((baseRows[0].sample_rows as unknown[]).length).toBe(30);
    expect((baseRows[0].data as unknown[]).length).toBe(42);

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        project_id: PROJECT_ID,
        stage: 'base_analyze',
        status: 'pending',
        payload: { base_id: body.base.id },
      }),
    );
  });
});
