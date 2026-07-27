/** @jest-environment node */

/**
 * Tests for the dossier stage surface:
 *
 *   POST /api/tools/hypothesis-engine/verticals/[id]/dossier
 *     201 -> { ok, job } — inserts ONE he_jobs row (stage 'dossier', payload {vertical_id})
 *     200 -> { ok, job } — dedupe: pending/running dossier job for this vertical already exists
 *     404 -> { error } when the vertical does not exist
 *
 *   GET /api/tools/hypothesis-engine/projects/[id]
 *     200 -> response now also carries `dossiers` (he_vertical_dossiers without
 *            tokens/model) and `cases` (he_cases WITHOUT the heavy text field).
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

import { POST } from '@/app/api/tools/hypothesis-engine/verticals/[id]/dossier/route';
import { GET } from '@/app/api/tools/hypothesis-engine/projects/[id]/route';

function makePostReq(): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/verticals/v1/dossier', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

function makeGetReq(): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/projects/p1', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const verticalParams = { params: Promise.resolve({ id: 'v1' }) };
const projectParams = { params: Promise.resolve({ id: 'p1' }) };

describe('POST verticals/[id]/dossier', () => {
  it('enqueues a dossier job for the vertical (201)', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        he_jobs: [],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { ok: boolean; job: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.job.stage).toBe('dossier');
    expect(body.job.status).toBe('pending');
    expect(body.job.payload).toEqual({ vertical_id: 'v1' });

    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('returns 200 with the existing job when a dossier job is already pending for this vertical', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'dossier', status: 'pending', payload: { vertical_id: 'v1' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; job: { id: string } };
    expect(body.job.id).toBe('j1');
    // No duplicate job inserted.
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('dedupes a running dossier job too', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'dossier', status: 'running', payload: { vertical_id: 'v1' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('does not dedupe against dossier jobs of OTHER verticals', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [
          { id: 'v1', project_id: 'p1' },
          { id: 'v2', project_id: 'p1' },
        ],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'dossier', status: 'pending', payload: { vertical_id: 'v2' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });

  it('ignores other stages when checking for conflicts', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1' }],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'vocab', status: 'running', payload: { vertical_id: 'v1' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });

  it('returns 404 when the vertical does not exist', async () => {
    mockDb = createMockSupabase({ tables: { he_verticals: [], he_jobs: [] } });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});

describe('GET projects/[id] — dossiers and cases', () => {
  it('returns dossiers and cases scoped to the project', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'researched' }],
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства', rank: 1 }],
        he_vertical_dossiers: [
          {
            id: 'd1',
            vertical_id: 'v1',
            project_id: 'p1',
            status: 'ready',
            data: { counters: { companies_total: 1200 }, computed_at: '2026-07-27T00:00:00Z' },
            error: null,
          },
          // Чужой проект — не должен попасть в выдачу.
          { id: 'd2', vertical_id: 'v9', project_id: 'p2', status: 'ready', data: {}, error: null },
        ],
        he_cases: [
          {
            id: 'c1',
            project_id: 'p1',
            source: 'upload',
            filename: 'case.pdf',
            industry: 'HR',
            client_type: 'b2b',
            task: 'массовый подбор',
            metrics: { reply_pct: 12 },
            result: '30 встреч',
            text: 'ПОЛНЫЙ ТЕКСТ КЕЙСА — не должен отдаваться списком',
            created_at: '2026-07-20T00:00:00Z',
          },
          { id: 'c2', project_id: 'p2', source: 'site', filename: null, created_at: '2026-07-21T00:00:00Z' },
        ],
      },
    });

    const res = await GET(makeGetReq(), projectParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      dossiers: Array<{ id: string; vertical_id: string; status: string; data: unknown; error: string | null }>;
      cases: Array<{ id: string; source: string; filename: string | null; metrics: unknown; text?: unknown }>;
    };

    expect(body.dossiers.map((d) => d.id)).toEqual(['d1']);
    expect(body.dossiers[0]).toEqual(
      expect.objectContaining({ vertical_id: 'v1', status: 'ready', error: null }),
    );
    expect((body.dossiers[0].data as { counters: { companies_total: number } }).counters.companies_total).toBe(1200);

    expect(body.cases.map((c) => c.id)).toEqual(['c1']);
    expect(body.cases[0].metrics).toEqual({ reply_pct: 12 });
  });

  it('asks for dossier/case list columns only — no heavy fields (cases without text)', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'researched' }],
        he_verticals: [],
        he_vertical_dossiers: [],
        he_cases: [],
      },
    });

    const res = await GET(makeGetReq(), projectParams);
    expect(res.status).toBe(200);

    const dossierSelect = mockDb.selects.find((s) => s.table === 'he_vertical_dossiers');
    expect(dossierSelect?.columns).toBe('id, vertical_id, status, data, error');

    const caseSelect = mockDb.selects.find((s) => s.table === 'he_cases');
    expect(caseSelect?.columns).toContain('metrics');
    expect(caseSelect?.columns).toContain('result');
    expect(caseSelect?.columns).not.toContain('text');
  });

  it('returns empty dossiers/cases arrays when the project has none', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', name: 'P', website_url: 'https://x.example/', status: 'draft' }],
        he_verticals: [],
      },
    });

    const res = await GET(makeGetReq(), projectParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { dossiers: unknown[]; cases: unknown[] };
    expect(body.dossiers).toEqual([]);
    expect(body.cases).toEqual([]);
  });
});
