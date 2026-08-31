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

import { POST } from '@/app/api/bench/v1/jobs/[id]/stop/route';

function request(id: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}/stop?tool=yandexmaps`),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: { yandex_maps_jobs: [{ id: 'j1', user_id: ROBOT, status: 'running' }] },
  });
});

describe('POST /api/bench/v1/jobs/{id}/stop', () => {
  it('на инструмент без остановки отвечает conflict с причиной', async () => {
    // Яндекс.Карты остановку не поддерживают: ни ручки, ни статуса
    // «остановлена» в ограничении таблицы. Врать «остановил» нельзя.
    const res = await POST(request('j1'), ctx('j1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('остановку');
  });

  it('ничего не меняет в таблице задач', async () => {
    await POST(request('j1'), ctx('j1'));
    expect(mockDb.updates).toHaveLength(0);
  });

  it('о недоступности остановки можно узнать заранее из каталога', async () => {
    const { describeBenchTool, getBenchTool } = await import('@/lib/bench/registry');
    const described = describeBenchTool(getBenchTool('yandexmaps')!);
    expect(described.stop_supported).toBe(false);
  });
});

describe('остановка там, где она настоящая', () => {
  function googleRequest(id: string): NextRequest {
    return {
      headers: { get: () => null },
      nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}/stop?tool=googlemaps`),
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    KEY.allowed_tools = ['googlemaps'];
    mockDb = createMockSupabase({
      tables: {
        google_maps_jobs: [
          { id: 'g1', user_id: ROBOT, status: 'running' },
          { id: 'g2', user_id: ROBOT, status: 'completed' },
        ],
      },
    });
  });

  afterEach(() => {
    KEY.allowed_tools = ['yandexmaps'];
  });

  it('переводит выполняющуюся задачу в остановленную', async () => {
    const res = await POST(googleRequest('g1'), ctx('g1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('stopped');
  });

  it('пишет в таблицу именно тот статус, который слушает воркер', async () => {
    await POST(googleRequest('g1'), ctx('g1'));
    const update = mockDb.updates.find((u) => u.table === 'google_maps_jobs');
    expect(update?.patch).toEqual({ status: 'stopped' });
  });

  it('завершённую задачу останавливать нечего', async () => {
    const res = await POST(googleRequest('g2'), ctx('g2'));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'conflict' } });
  });

  it('чужая задача — not_found, а не conflict', async () => {
    const res = await POST(googleRequest('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
  });
});
