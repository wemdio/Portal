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
      `https://portal.local/api/bench/v1/jobs/${id}/results?tool=yandexmaps${query}`,
    ),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  logBenchRequest.mockClear();
  mockDb = createMockSupabase({
    // Без этого флага мок игнорирует .order/.limit — и тест постраничности
    // проходил бы вхолостую, ничего на деле не проверяя.
    enforceQueryWindows: true,
    tables: {
      yandex_maps_jobs: [{ id: 'j1', user_id: ROBOT, status: 'completed' }],
      yandex_maps_organizations: [
        { id: 'o1', job_id: 'j1', name: 'Альфа', created_at: '2026-08-31T10:00:00Z' },
        { id: 'o2', job_id: 'j1', name: 'Бета', created_at: '2026-08-31T10:00:01Z' },
      ],
    },
  });
});

describe('GET /api/bench/v1/jobs/{id}/results', () => {
  it('отдаёт строки результата', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body.rows).toHaveLength(2);
  });

  it('страницу ограничивает limit и отдаёт курсор', async () => {
    const body = await (await GET(request('j1', '&limit=1'), ctx('j1'))).json();
    expect(body.rows).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.cursor).toBe('o1');
  });

  it('курсор продолжает выдачу с нужного места', async () => {
    const body = await (await GET(request('j1', '&cursor=o1'), ctx('j1'))).json();
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['o2']);
  });

  it('чужая задача — not_found, и строки не читаются', async () => {
    const res = await GET(request('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
  });

  it('считает отданные строки в журнал — по ним идёт суточная норма', async () => {
    await GET(request('j1'), ctx('j1'));
    expect(logBenchRequest).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'results', rowsReturned: 2 }),
    );
  });
});
