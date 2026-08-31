/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';

const KEY = {
  id: 'k1',
  name: 'Дима',
  key_hash: 'h',
  key_last4: '1234',
  robot_user_id: ROBOT,
  allowed_tools: ['yandexmaps'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
  revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    ...actual,
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET } from '@/app/api/bench/v1/jobs/[id]/route';

function request(id: string, tool = 'yandexmaps'): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}?tool=${tool}`),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      yandex_maps_jobs: [
        {
          id: 'j1',
          user_id: ROBOT,
          status: 'running',
          processed_organizations: 5,
          total_organizations: 50,
          created_at: '2026-08-31T10:00:00Z',
          completed_at: null,
          error_message: null,
        },
      ],
    },
  });
});

describe('GET /api/bench/v1/jobs/{id}', () => {
  it('отдаёт свою задачу', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body.id).toBe('j1');
    expect(body.status).toBe('running');
    expect(body.progress).toEqual({ done: 5, total: 50 });
  });

  it('чужая задача неотличима от несуществующей', async () => {
    // Отвечаем not_found, а не forbidden: иначе перебором идентификаторов
    // можно было бы выяснить, какие задачи существуют у других.
    const res = await GET(request('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'not_found' } });
  });

  it('не протаскивает user_id наружу', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body).not.toHaveProperty('user_id');
  });

  it('без параметра tool просит его указать', async () => {
    const req = {
      headers: { get: () => null },
      nextUrl: new URL('https://portal.local/api/bench/v1/jobs/j1'),
    } as unknown as NextRequest;
    expect((await GET(req, ctx('j1'))).status).toBe(400);
  });
});
