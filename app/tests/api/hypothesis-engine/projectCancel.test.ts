/** @jest-environment node */

/**
 * Tests for /api/tools/hypothesis-engine/projects/[id]/cancel.
 *
 *   POST
 *     200 -> { ok, cancelled } — pending/running джобы → 'cancelled',
 *            проект researching → draft, базы collecting/analyzing → failed
 *     404 -> проект не найден
 *     409 -> нет активных задач
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

import { POST } from '@/app/api/tools/hypothesis-engine/projects/[id]/cancel/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/projects/p1/cancel', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

type Row = Record<string, unknown>;

function seed(opts: { projectStatus?: string; jobs?: Row[]; bases?: Row[] } = {}) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: opts.projectStatus ? [{ id: 'p1', status: opts.projectStatus, error: null }] : [],
      he_jobs: opts.jobs ?? [],
      he_bases: opts.bases ?? [],
    },
  });
}

describe('POST /api/tools/hypothesis-engine/projects/[id]/cancel', () => {
  it('returns 404 when the project does not exist', async () => {
    seed();
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
  });

  it('returns 409 when there are no active jobs', async () => {
    seed({
      projectStatus: 'researched',
      jobs: [{ id: 'j1', project_id: 'p1', stage: 'chain', status: 'done' }],
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Нет активных задач/);
    expect(mockDb.getRows('he_jobs')[0].status).toBe('done');
  });

  it('cancels pending/running jobs, keeps done, downgrades researching project to draft', async () => {
    seed({
      projectStatus: 'researching',
      jobs: [
        { id: 'j1', project_id: 'p1', stage: 'hypotheses', status: 'running' },
        { id: 'j2', project_id: 'p1', stage: 'evidence', status: 'pending' },
        { id: 'j3', project_id: 'p1', stage: 'site_profile', status: 'done' },
        { id: 'j4', project_id: 'other', stage: 'chain', status: 'running' },
      ],
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; cancelled?: number };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(2);

    const jobs = Object.fromEntries(mockDb.getRows('he_jobs').map((j) => [j.id, j]));
    expect(jobs.j1.status).toBe('cancelled');
    expect(jobs.j2.status).toBe('cancelled');
    expect(jobs.j1.finished_at).toBeTruthy();
    expect(jobs.j3.status).toBe('done');
    // Чужой проект не задет.
    expect(jobs.j4.status).toBe('running');

    const project = mockDb.getRows('he_projects')[0];
    expect(project.status).toBe('draft');
  });

  it('keeps project status when it is not researching (cancel of a chain job)', async () => {
    seed({
      projectStatus: 'researched',
      jobs: [{ id: 'j1', project_id: 'p1', stage: 'chain', status: 'running' }],
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_jobs')[0].status).toBe('cancelled');
    expect(mockDb.getRows('he_projects')[0].status).toBe('researched');
  });

  it('fails bases stuck in collecting/analyzing so they do not hang forever', async () => {
    seed({
      projectStatus: 'researched',
      jobs: [{ id: 'j1', project_id: 'p1', stage: 'base_collect', status: 'pending' }],
      bases: [
        { id: 'b1', project_id: 'p1', status: 'collecting', error: null },
        { id: 'b2', project_id: 'p1', status: 'analyzing', error: null },
        { id: 'b3', project_id: 'p1', status: 'analyzed', error: null },
      ],
    });

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const bases = Object.fromEntries(mockDb.getRows('he_bases').map((b) => [b.id, b]));
    expect(bases.b1.status).toBe('failed');
    expect(bases.b1.error).toBe('Отменено пользователем');
    expect(bases.b2.status).toBe('failed');
    expect(bases.b3.status).toBe('analyzed');
  });
});
