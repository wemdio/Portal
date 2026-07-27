/** @jest-environment node */

/**
 * Tests for PATCH /api/tools/hypothesis-engine/hypotheses/[id].
 *
 *   200 -> { hypothesis, verticals } with the new status persisted and
 *          project verticals' potential_pct/rank recomputed under the markup.
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
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

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

describe('PATCH hypotheses — пересчёт вертикалей после разметки', () => {
  beforeEach(() => {
    mockDb = createMockSupabase({
      tables: {
        he_verticals: [
          { id: 'v1', project_id: 'p1', name: 'Финтех', potential_pct: 42, rank: 2 },
          { id: 'v2', project_id: 'p1', name: 'Стоматологии', potential_pct: 60, rank: 1 },
        ],
        he_hypotheses: [
          { id: 'h1', project_id: 'p1', vertical_id: 'v1', tier: 1, title: 'Банки', status: 'proposed', potential_pct: 40 },
          { id: 'h2', project_id: 'p1', vertical_id: 'v1', tier: 2, title: 'Необанки', status: 'proposed', potential_pct: 35 },
          { id: 'h3', project_id: 'p1', vertical_id: 'v2', tier: 1, title: 'Стоматологии', status: 'proposed', potential_pct: 60 },
        ],
      },
    });
  });

  it('принятие гипотезы: % вертикали считается только по принятым, ответ несёт свежие вертикали', async () => {
    const res = await PATCH(makeReq({ status: 'accepted' }), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      hypothesis: { id: string };
      verticals: Array<{ id: string; potential_pct: number; rank: number }>;
    };
    expect(body.hypothesis.id).toBe('h1');
    // v1 — только принятая h1 (40), v2 — без принятых, по неотклонённым (60).
    expect(body.verticals).toEqual([
      { id: 'v2', potential_pct: 60, rank: 1 },
      { id: 'v1', potential_pct: 40, rank: 2 },
    ]);

    const rows = mockDb.getRows('he_verticals');
    expect(rows.find((r) => r.id === 'v1')).toMatchObject({ potential_pct: 40, rank: 2 });
    expect(rows.find((r) => r.id === 'v2')).toMatchObject({ potential_pct: 60, rank: 1 });
    // Изменилась только v1 (% 42 → 40) — v2 не перезаписываем.
    const vUpdates = mockDb.updates.filter((u) => u.table === 'he_verticals');
    expect(vUpdates).toHaveLength(1);
    expect(vUpdates[0].filters).toEqual([{ column: 'id', op: 'eq', value: 'v1' }]);
  });

  it('вертикаль, где все гипотезы отклонены, получает 0% и последний rank', async () => {
    const res = await PATCH(makeReq({ status: 'rejected' }), paramsFor('h3'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      verticals: Array<{ id: string; potential_pct: number; rank: number }>;
    };
    // v2 без eligible-участников → 0% и хвост рейтинга;
    // v1 — по неотклонённым: max 40 + 2 за второго = 42.
    expect(body.verticals).toEqual([
      { id: 'v1', potential_pct: 42, rank: 1 },
      { id: 'v2', potential_pct: 0, rank: 2 },
    ]);

    const rows = mockDb.getRows('he_verticals');
    expect(rows.find((r) => r.id === 'v2')).toMatchObject({ potential_pct: 0, rank: 2 });
    expect(rows.find((r) => r.id === 'v1')).toMatchObject({ potential_pct: 42, rank: 1 });
  });

  it('разметка, не меняющая расклад, не трогает he_verticals', async () => {
    // Сид уже соответствует пересчёту по неотклонённым — PATCH proposed → proposed.
    const res = await PATCH(makeReq({ status: 'proposed' }), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      verticals: Array<{ id: string; potential_pct: number; rank: number }>;
    };
    expect(body.verticals).toEqual([
      { id: 'v2', potential_pct: 60, rank: 1 },
      { id: 'v1', potential_pct: 42, rank: 2 },
    ]);
    expect(mockDb.updates.filter((u) => u.table === 'he_verticals')).toHaveLength(0);
  });
});
