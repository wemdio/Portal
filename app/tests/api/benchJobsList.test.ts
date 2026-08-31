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
jest.mock('@/lib/bench/limits', () => ({
  checkBenchLimits: jest.fn(async () => null),
  checkActiveJobs: jest.fn(async () => null),
}));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET } from '@/app/api/bench/v1/jobs/route';

function request(query: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs${query}`),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      yandex_maps_jobs: [
        {
          id: 'j1',
          user_id: ROBOT,
          status: 'completed',
          processed_organizations: 10,
          total_organizations: 10,
          created_at: '2026-08-31T09:00:00Z',
          completed_at: '2026-08-31T09:30:00Z',
          error_message: null,
        },
        {
          id: 'j2',
          user_id: ROBOT,
          status: 'pending',
          processed_organizations: 0,
          total_organizations: 0,
          created_at: '2026-08-31T10:00:00Z',
          completed_at: null,
          error_message: null,
        },
      ],
    },
  });
});

describe('GET /api/bench/v1/jobs', () => {
  it('отдаёт задачи в общей форме, без внутренних полей', async () => {
    const body = await (await GET(request('?tool=yandexmaps'))).json();
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]).toHaveProperty('rows_found');
    expect(body.jobs[0]).not.toHaveProperty('user_id');
  });

  it('фильтрует по общему словарю статусов', async () => {
    const body = await (await GET(request('?tool=yandexmaps&status=done'))).json();
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(['j1']);
  });

  it('без параметра tool просит его указать', async () => {
    const res = await GET(request(''));
    expect(res.status).toBe(400);
  });

  it('инструмент вне списка ключа недоступен и в списке', async () => {
    const res = await GET(request('?tool=company-base'));
    expect([403, 404]).toContain(res.status);
  });

  it('поисковый источник не выдаёт себя за задачный', async () => {
    const res = await GET(request('?tool=company-base'));
    expect(res.status).not.toBe(200);
  });
});
