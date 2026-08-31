/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';
const URL_OK = 'https://yandex.ru/maps/?text=кофейни';

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

import { POST } from '@/app/api/bench/v1/jobs/route';

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({ tables: { yandex_maps_jobs: [] } });
});

describe('POST /api/bench/v1/jobs', () => {
  it('ставит задачу и отдаёт её общим представлением', async () => {
    const res = await POST(request({
      tool: 'yandexmaps',
      params: { search_urls: [URL_OK], max_results: 100 },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tool).toBe('yandexmaps');
    expect(body.status).toBe('queued');
  });

  it('владельцем задачи становится робот ключа', async () => {
    await POST(request({ tool: 'yandexmaps', params: { search_urls: [URL_OK] } }));
    expect(mockDb.inserts[0].rows[0].user_id).toBe(ROBOT);
  });

  it('инструмент вне списка ключа не существует для него', async () => {
    const res = await POST(request({ tool: 'company-base', params: {} }));
    expect([403, 404]).toContain(res.status);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('неизвестный инструмент — not_found', async () => {
    const res = await POST(request({ tool: 'нет-такого', params: {} }));
    expect(res.status).toBe(404);
  });

  it('кривые параметры не создают задачу', async () => {
    const res = await POST(request({ tool: 'yandexmaps', params: { search_urls: [] } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'invalid_params' } });
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('владельца из тела запроса игнорирует — строгая схема его отвергает', async () => {
    const res = await POST(request({
      tool: 'yandexmaps',
      params: { search_urls: [URL_OK], user_id: 'чужой' },
    }));
    expect(res.status).toBe(400);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('не-JSON тело не роняет роут', async () => {
    const bad = {
      headers: { get: () => null },
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as NextRequest;
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });
});
