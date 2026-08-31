/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const KEY = {
  id: 'k1',
  name: 'Дима',
  key_hash: 'h',
  key_last4: '1234',
  robot_user_id: 'r1',
  allowed_tools: ['company-base'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
  revoked_at: null,
};

let mockDb: MockSupabaseClient;
const logBenchRequest = jest.fn(async () => {});

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    ...actual,
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({
  logBenchRequest: (entry: unknown) => logBenchRequest(entry as never),
}));

import { POST } from '@/app/api/bench/v1/search/route';

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  logBenchRequest.mockClear();
  mockDb = createMockSupabase({
    enforceQueryWindows: true,
    tables: {
      pdl_companies: [
        { id: 'c1', name: 'Alpha', country: 'russia', industry: 'software', size: '11-50' },
        { id: 'c2', name: 'Beta', country: 'germany', industry: 'retail', size: '51-200' },
      ],
    },
  });
});

describe('POST /api/bench/v1/search', () => {
  it('ищет и отдаёт страницу', async () => {
    const body = await (await POST(request({ source: 'company-base', filters: {} }))).json();
    expect(body.rows).toHaveLength(2);
    expect(body).toHaveProperty('has_more');
  });

  it('кривые фильтры — invalid_params', async () => {
    const res = await POST(request({ source: 'company-base', filters: { drop: 1 } }));
    expect(res.status).toBe(400);
  });

  it('источник вне списка ключа недоступен', async () => {
    const res = await POST(request({ source: 'yandexmaps', filters: {} }));
    expect([403, 404]).toContain(res.status);
  });

  it('задачный инструмент не выдаёт себя за поисковый', async () => {
    const res = await POST(request({ source: 'yandexmaps', filters: {} }));
    expect(res.status).not.toBe(200);
  });

  it('считает отданные строки в журнал — по ним идёт суточная норма', async () => {
    await POST(request({ source: 'company-base', filters: {} }));
    expect(logBenchRequest).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'search', rowsReturned: 2 }),
    );
  });

  it('не-JSON тело не роняет роут', async () => {
    const bad = {
      headers: { get: () => null },
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);
  });
});
