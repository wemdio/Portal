/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';
import { hashBenchKey } from '@/lib/bench/keys';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';
const GOOD_KEY = 'bench_live_good';
const REVOKED_KEY = 'bench_live_revoked';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/bench/db', () => ({
  createBenchDb: jest.fn((ownerId: string) => ({ ownerId })),
}));

import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';

function request(header: string | null, apiKeyHeader: string | null = null): NextRequest {
  return {
    headers: {
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === 'authorization') return header;
        if (n === 'x-api-key') return apiKeyHeader;
        return null;
      },
    },
  } as unknown as NextRequest;
}

const BASE_KEY = {
  robot_user_id: ROBOT_ID,
  allowed_tools: ['yandexmaps'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
};

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      bench_api_keys: [
        {
          id: 'k1',
          name: 'Дима',
          key_hash: hashBenchKey(GOOD_KEY),
          key_last4: 'good',
          revoked_at: null,
          ...BASE_KEY,
        },
        {
          id: 'k2',
          name: 'Старый',
          key_hash: hashBenchKey(REVOKED_KEY),
          key_last4: 'oked',
          revoked_at: '2026-08-01T00:00:00Z',
          ...BASE_KEY,
        },
      ],
    },
  });
});

describe('authenticateBench', () => {
  it('пускает по действующему ключу', async () => {
    const result = await authenticateBench(request(`Bearer ${GOOD_KEY}`));
    expect(isBenchAuth(result) && result.key.id).toBe('k1');
  });

  it('принимает ключ и через заголовок X-Api-Key', async () => {
    const result = await authenticateBench(request(null, GOOD_KEY));
    expect(isBenchAuth(result) && result.key.id).toBe('k1');
  });

  it('без заголовка отвечает unauthorized', async () => {
    const result = await authenticateBench(request(null));
    expect(isBenchAuth(result)).toBe(false);
    expect((result as Response).status).toBe(401);
  });

  it('неизвестный ключ — unauthorized', async () => {
    const result = await authenticateBench(request('Bearer bench_live_nope'));
    expect((result as Response).status).toBe(401);
  });

  it('отозванный ключ перестаёт работать сразу', async () => {
    const result = await authenticateBench(request(`Bearer ${REVOKED_KEY}`));
    expect((result as Response).status).toBe(401);
  });

  it('ищет ключ по отпечатку — сам ключ в запрос к базе не попадает', async () => {
    await authenticateBench(request(`Bearer ${GOOD_KEY}`));
    expect(JSON.stringify(mockDb.selects)).not.toContain(GOOD_KEY);
  });

  it('не читает из базы столбцы, которых не должно быть в ответе', async () => {
    await authenticateBench(request(`Bearer ${GOOD_KEY}`));
    expect(mockDb.selects[0].columns).not.toContain('*');
  });
});

describe('assertToolAllowed', () => {
  const key = { ...BASE_KEY, id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', revoked_at: null };

  it('пропускает разрешённый инструмент', () => {
    expect(assertToolAllowed(key, 'yandexmaps')).toBeNull();
  });

  it('запрещённый инструмент даёт 403', () => {
    const denied = assertToolAllowed(key, 'company-base');
    expect(denied?.status).toBe(403);
  });
});
