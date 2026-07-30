/** @jest-environment node */

/**
 * Tests for the auto-collect enqueue surface:
 *
 *   POST /api/tools/hypothesis-engine/verticals/[id]/collect
 *     201 -> { ok, base } — inserts he_bases (source='auto', status='collecting')
 *            + he_jobs (stage 'base_collect', payload {base_id})
 *     200 -> { ok, base } — dedupe: an auto base is already collecting, a
 *            pending/running base_collect job targets a non-failed base of
 *            this vertical, or the insert loses the unique-index race (23505)
 *     404 -> { error } when the vertical does not exist
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

import { POST } from '@/app/api/tools/hypothesis-engine/verticals/[id]/collect/route';

function makePostReq(): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/verticals/v1/collect', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const verticalParams = { params: Promise.resolve({ id: 'v1' }) };

describe('POST verticals/[id]/collect', () => {
  it('creates an auto base and enqueues base_collect (201)', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        he_bases: [],
        he_jobs: [],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { ok: boolean; base: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.base.status).toBe('collecting');

    const bases = mockDb.getRows('he_bases');
    expect(bases).toHaveLength(1);
    expect(bases[0]).toEqual(
      expect.objectContaining({
        id: body.base.id,
        project_id: 'p1',
        vertical_id: 'v1',
        source: 'auto',
        status: 'collecting',
        filename: 'auto: HR-агентства',
        row_count: 0,
        columns: [],
        data: [],
      }),
    );

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        project_id: 'p1',
        stage: 'base_collect',
        status: 'pending',
        payload: { base_id: body.base.id },
      }),
    );
  });

  it('returns 200 with the existing base when an auto base is already collecting', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        he_bases: [
          { id: 'b9', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'collecting' },
        ],
        he_jobs: [],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; base: { id: string } };
    expect(body.base.id).toBe('b9');
    expect(mockDb.getRows('he_bases')).toHaveLength(1);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('returns 200 when a pending base_collect job already targets a base of this vertical', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        // База уже вышла из collecting, но джоба ещё активна.
        he_bases: [
          { id: 'b8', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzing' },
        ],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'base_collect', status: 'pending', payload: { base_id: 'b8' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; base: { id: string } };
    expect(body.base.id).toBe('b8');
    expect(mockDb.getRows('he_bases')).toHaveLength(1);
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('does not dedupe against base_collect jobs of OTHER verticals', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [
          { id: 'v1', project_id: 'p1', name: 'HR-агентства' },
          { id: 'v2', project_id: 'p1', name: 'Логистика' },
        ],
        he_bases: [
          { id: 'b7', project_id: 'p1', vertical_id: 'v2', source: 'auto', status: 'collecting' },
        ],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'base_collect', status: 'running', payload: { base_id: 'b7' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);
    expect(mockDb.getRows('he_bases')).toHaveLength(2);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });

  it('starts a new collect when the job-targeted base is failed (failed is not a conflict)', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        // Сборка уже падала: джоба ещё активна, но её база в failed — retry
        // обязан создать новую базу, а не вернуть упавшую как «уже идёт».
        he_bases: [
          { id: 'b8', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'failed' },
        ],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'base_collect', status: 'running', payload: { base_id: 'b8' } },
        ],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);

    const bases = mockDb.getRows('he_bases');
    expect(bases).toHaveLength(2);
    expect(bases[1]).toEqual(
      expect.objectContaining({ vertical_id: 'v1', source: 'auto', status: 'collecting' }),
    );
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });

  it('maps a 23505 insert race to 200 with the conflicting collecting base', async () => {
    // Гонка: проверки дедупа прошли до чужого COMMIT'а, а insert упал на
    // partial unique index he_bases_one_collecting_per_vertical.
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        he_bases: [],
        he_jobs: [],
      },
      errorInserts: {
        he_bases: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "he_bases_one_collecting_per_vertical"',
          // Выигравший параллельный POST: его база видна после нашего фейла.
          commitRow: true,
        },
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; base: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.base.status).toBe('collecting');

    // Возвращаем чужую collecting-базу, свою джобу не создаём.
    const bases = mockDb.getRows('he_bases');
    expect(bases).toHaveLength(1);
    expect(body.base.id).toBe(bases[0].id);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('ignores uploaded (non-auto) bases when checking for conflicts', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'HR-агентства' }],
        he_bases: [
          { id: 'b5', project_id: 'p1', vertical_id: 'v1', source: 'upload', status: 'analyzing' },
        ],
        he_jobs: [],
      },
    });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(201);
    expect(mockDb.getRows('he_bases')).toHaveLength(2);
  });

  it('returns 404 when the vertical does not exist', async () => {
    mockDb = createMockSupabase({ tables: { he_verticals: [], he_bases: [], he_jobs: [] } });

    const res = await POST(makePostReq(), verticalParams);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_bases')).toHaveLength(0);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});
