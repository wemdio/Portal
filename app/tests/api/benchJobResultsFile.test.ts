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
  allowed_tools: ['inn-enrich'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
  revoked_at: null,
};

let mockDb: MockSupabaseClient;
const signBenchResultUrl = jest.fn(async (_b: string, _p: string): Promise<string | null> => 'https://storage.local/signed?token=abc');

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    ...actual,
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));
jest.mock('@/lib/bench/resultFile', () => ({
  BENCH_FILE_URL_TTL_SECONDS: 900,
  signBenchResultUrl: (b: string, p: string) => signBenchResultUrl(b, p),
}));

import { GET } from '@/app/api/bench/v1/jobs/[id]/results/route';

function request(id: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(
      `https://portal.local/api/bench/v1/jobs/${id}/results?tool=inn-enrich`,
    ),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  signBenchResultUrl.mockClear();
  signBenchResultUrl.mockResolvedValue('https://storage.local/signed?token=abc');
  mockDb = createMockSupabase({
    tables: {
      inn_enrich_jobs: [
        { id: 'j1', user_id: ROBOT, status: 'completed', result_path: 'j1/result.csv' },
        { id: 'j2', user_id: ROBOT, status: 'running', result_path: null },
      ],
    },
  });
});

describe('результат-файл', () => {
  it('отдаёт временную ссылку, а не строки', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body.kind).toBe('file');
    expect(body.url).toContain('https://');
    expect(body.expires_in_seconds).toBe(900);
    expect(body.rows).toBeUndefined();
  });

  it('подписывает ровно тот путь, что лежит в задаче', async () => {
    await GET(request('j1'), ctx('j1'));
    expect(signBenchResultUrl).toHaveBeenCalledWith('inn-enrich-exports', 'j1/result.csv');
  });

  it('пока результата нет — внятный отказ, а не пустая ссылка', async () => {
    const res = await GET(request('j2'), ctx('j2'));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'conflict' } });
  });

  it('чужая задача — not_found, ссылку не подписываем', async () => {
    const res = await GET(request('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
    expect(signBenchResultUrl).not.toHaveBeenCalled();
  });

  it('сбой подписи не выдаёт битую ссылку', async () => {
    signBenchResultUrl.mockResolvedValueOnce(null);
    const res = await GET(request('j1'), ctx('j1'));
    expect(res.status).toBe(500);
  });
});
