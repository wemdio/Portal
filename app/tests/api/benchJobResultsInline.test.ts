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
  allowed_tools: ['base-constructor'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
  revoked_at: null,
};

let mockDb: MockSupabaseClient;
const logBenchRequest = jest.fn(async (_entry: unknown) => {});

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    ...actual,
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({
  logBenchRequest: (entry: unknown) => logBenchRequest(entry),
}));

import { GET } from '@/app/api/bench/v1/jobs/[id]/results/route';

function request(id: string, query = ''): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(
      `https://portal.local/api/bench/v1/jobs/${id}/results?tool=base-constructor${query}`,
    ),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const ROWS = [
  ['company', 'email'],
  ['Альфа', 'a@alpha.ru'],
  ['Бета', 'b@beta.ru'],
  ['Гамма', 'g@gamma.ru'],
];

beforeEach(() => {
  logBenchRequest.mockClear();
  mockDb = createMockSupabase({
    tables: {
      base_constructor_jobs: [
        { id: 'j1', user_id: ROBOT, status: 'completed', data: ROWS },
      ],
    },
  });
});

describe('результаты, лежащие внутри задачи', () => {
  it('отдаёт весь массив, когда он помещается в страницу', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body.rows).toHaveLength(4);
    expect(body.has_more).toBe(false);
    expect(body.cursor).toBeNull();
  });

  it('листает по номеру элемента', async () => {
    // В JSON-массиве нет ни id, ни порядка, кроме позиции, — поэтому здесь
    // курсор это номер элемента, а не идентификатор строки.
    const first = await (await GET(request('j1', '&limit=2'), ctx('j1'))).json();
    expect(first.rows).toHaveLength(2);
    expect(first.cursor).toBe('2');
    expect(first.has_more).toBe(true);

    const second = await (await GET(request('j1', '&limit=2&cursor=2'), ctx('j1'))).json();
    expect(second.rows).toEqual([ROWS[2], ROWS[3]]);
    expect(second.has_more).toBe(false);
  });

  it('чужая задача — not_found', async () => {
    const res = await GET(request('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
  });

  it('пустой результат не ломает выдачу', async () => {
    mockDb = createMockSupabase({
      tables: { base_constructor_jobs: [{ id: 'j2', user_id: ROBOT, data: null }] },
    });
    const body = await (await GET(request('j2'), ctx('j2'))).json();
    expect(body.rows).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it('считает отданные строки в журнал', async () => {
    await GET(request('j1', '&limit=2'), ctx('j1'));
    expect(logBenchRequest).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'results', rowsReturned: 2 }),
    );
  });
});
