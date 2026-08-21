/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000221';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockAuthorized = true;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () =>
    mockAuthorized
      ? { auth: { supabase: mockDb, userId: USER_ID, role: 'specialist' } }
      : {
          error: new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        },
  ),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/tools/vertical-engine-v2/projects/[id]/research/route';

function request(): NextRequest {
  return new Request('http://x/api/tools/vertical-engine-v2/projects/p1/research', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

describe('POST /api/tools/vertical-engine-v2/projects/[id]/research', () => {
  beforeEach(() => {
    mockAuthorized = true;
  });

  it('enqueues site_profile on ve_jobs and does not touch he_*', async () => {
    mockDb = createMockSupabase({
      tables: {
        ve_projects: [
          { id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'draft', error: 'old' },
        ],
        ve_jobs: [],
        he_projects: [{ id: 'legacy-1', name: 'ENG project' }],
        he_jobs: [],
      },
    });

    const res = await POST(request(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; job: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.job.stage).toBe('site_profile');
    expect(body.job.status).toBe('pending');

    expect(mockDb.getRows('ve_jobs')).toHaveLength(1);
    expect(mockDb.getRows('ve_projects')[0]).toEqual(
      expect.objectContaining({ status: 'researching', error: null }),
    );
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
    expect(mockDb.getRows('he_projects')).toEqual([{ id: 'legacy-1', name: 'ENG project' }]);
    expect(mockDb.mutations.map((call) => call.table).every((table) => table.startsWith('ve_'))).toBe(
      true,
    );
  });

  it('returns 409 when a research-stage job is already pending', async () => {
    mockDb = createMockSupabase({
      tables: {
        ve_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'researching' }],
        ve_jobs: [{ id: 'j1', project_id: 'p1', stage: 'evidence', status: 'pending', payload: {} }],
      },
    });

    const res = await POST(request(), params);
    expect(res.status).toBe(409);
    expect(mockDb.getRows('ve_jobs')).toHaveLength(1);
  });
});
