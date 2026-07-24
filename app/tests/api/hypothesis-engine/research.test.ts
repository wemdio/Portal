/** @jest-environment node */

/**
 * Tests for POST /api/tools/hypothesis-engine/projects/[id]/research.
 *
 *   200 -> { ok: true, job } — inserts ONE he_jobs row (stage 'site_profile')
 *          and flips he_projects.status to 'researching'.
 *   409 -> { error } when a pending/running research-stage job already exists.
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

import { POST } from '@/app/api/tools/hypothesis-engine/projects/[id]/research/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/projects/p1/research', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

describe('POST research', () => {
  it('enqueues site_profile and marks the project researching', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'draft', error: 'old' }],
        he_jobs: [],
      },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; job: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.job.stage).toBe('site_profile');
    expect(body.job.status).toBe('pending');

    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
    expect(mockDb.getRows('he_projects')[0]).toEqual(
      expect.objectContaining({ status: 'researching', error: null }),
    );
  });

  it('returns 409 when a research-stage job is already pending', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'researching' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'evidence', status: 'pending', payload: {} },
        ],
      },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    // No duplicate job inserted.
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('returns 409 when a research-stage job is running', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'researching' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'site_profile', status: 'running', payload: {} },
        ],
      },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
  });

  it('allows a rerun when previous jobs are done/failed', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'failed', error: 'boom' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'clustering', status: 'failed', payload: {} },
        ],
      },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
    expect(mockDb.getRows('he_projects')[0]).toEqual(
      expect.objectContaining({ status: 'researching', error: null }),
    );
  });

  it('ignores non-research stages when checking for conflicts', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'researched' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'chain', status: 'running', payload: {} },
        ],
      },
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });
});
