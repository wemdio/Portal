/** @jest-environment node */

import type { NextRequest } from 'next/server';

const KEY = {
  id: 'k1',
  name: 'Дима',
  key_hash: 'h',
  key_last4: '1234',
  robot_user_id: 'r1',
  allowed_tools: ['yandexmaps'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
  revoked_at: null,
};

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    ...actual,
    authenticateBench: jest.fn(async () => ({ key: KEY, db: {} })),
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET } from '@/app/api/bench/v1/tools/route';

const req = { headers: { get: () => null } } as unknown as NextRequest;

describe('GET /api/bench/v1/tools', () => {
  it('показывает только разрешённые ключу инструменты', async () => {
    const body = await (await GET(req)).json();
    expect(body.tools.map((t: { id: string }) => t.id)).toEqual(['yandexmaps']);
  });

  it('сообщает про поддержку остановки', async () => {
    const body = await (await GET(req)).json();
    expect(body.tools[0].stop_supported).toBe(false);
    expect(body.tools[0].stop_reason).toContain('остановку');
  });

  it('несёт машинную схему параметров', async () => {
    const body = await (await GET(req)).json();
    expect(body.tools[0].params.properties).toHaveProperty('search_urls');
  });
});
