/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { checkBenchLimits } from '@/lib/bench/limits';
import type { BenchKeyRow } from '@/lib/bench/auth';

const KEY: BenchKeyRow = {
  id: 'k1',
  name: 'Дима',
  key_hash: 'h',
  key_last4: '1234',
  robot_user_id: 'r1',
  allowed_tools: ['yandexmaps'],
  rpm_limit: 2,
  daily_jobs_limit: 2,
  daily_rows_limit: 100,
  max_active_jobs: 3,
  revoked_at: null,
};

function seed(requests: Array<Record<string, unknown>>) {
  mockDb = createMockSupabase({ tables: { bench_api_requests: requests } });
}

const NOW = new Date('2026-08-31T12:00:00Z');
const RECENT = new Date('2026-08-31T11:59:30Z').toISOString();

function req(over: Record<string, unknown>) {
  return {
    key_id: 'k1',
    action: 'list_jobs',
    status_code: 200,
    rows_returned: 0,
    created_at: RECENT,
    ...over,
  };
}

describe('лимиты', () => {
  it('пропускает, пока норма не выбрана', async () => {
    seed([]);
    expect(await checkBenchLimits(KEY, 'read', NOW)).toBeNull();
  });

  it('режет по запросам в минуту', async () => {
    seed([req({}), req({})]);
    const res = await checkBenchLimits(KEY, 'read', NOW);
    expect(res?.status).toBe(429);
    await expect(res!.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('в отказе по частоте сказано, когда можно снова', async () => {
    seed([req({}), req({})]);
    const res = await checkBenchLimits(KEY, 'read', NOW);
    expect(res!.headers.get('Retry-After')).toBeTruthy();
  });

  it('старые запросы в минутное окно не попадают', async () => {
    const old = new Date('2026-08-31T11:50:00Z').toISOString();
    seed([req({ created_at: old }), req({ created_at: old })]);
    expect(await checkBenchLimits(KEY, 'read', NOW)).toBeNull();
  });

  it('режет по задачам в сутки', async () => {
    seed([
      req({ action: 'create_job', created_at: '2026-08-31T01:00:00Z' }),
      req({ action: 'create_job', created_at: '2026-08-31T02:00:00Z' }),
    ]);
    const res = await checkBenchLimits(KEY, 'create_job', NOW);
    await expect(res!.json()).resolves.toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('неудачные попытки не съедают суточную норму задач', async () => {
    seed([
      req({ action: 'create_job', status_code: 400, created_at: '2026-08-31T01:00:00Z' }),
      req({ action: 'create_job', status_code: 400, created_at: '2026-08-31T02:00:00Z' }),
    ]);
    expect(await checkBenchLimits(KEY, 'create_job', NOW)).toBeNull();
  });

  it('режет по строкам в сутки', async () => {
    seed([req({ action: 'results', rows_returned: 100, created_at: '2026-08-31T03:00:00Z' })]);
    const res = await checkBenchLimits(KEY, 'results', NOW);
    await expect(res!.json()).resolves.toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('норма строк общая для выгрузки задач и поиска', async () => {
    seed([req({ action: 'search', rows_returned: 100, created_at: '2026-08-31T03:00:00Z' })]);
    const res = await checkBenchLimits(KEY, 'results', NOW);
    expect(res?.status).toBe(429);
  });
});
