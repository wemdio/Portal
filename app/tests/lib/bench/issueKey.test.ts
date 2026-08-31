/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { hashBenchKey } from '@/lib/bench/keys';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';

type AdminDb = MockSupabaseClient & {
  auth: { admin: { createUser: jest.Mock; deleteUser: jest.Mock } };
};

let mockDb: AdminDb;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { DEFAULT_BENCH_LIMITS, issueBenchKey, revokeBenchKey } from '@/lib/bench/issueKey';

function build(seed?: Parameters<typeof createMockSupabase>[0]): AdminDb {
  const db = createMockSupabase(seed ?? { tables: { profiles: [], bench_api_keys: [] } });
  return Object.assign(db, {
    auth: {
      admin: {
        createUser: jest.fn(async () => ({ data: { user: { id: ROBOT_ID } }, error: null })),
        deleteUser: jest.fn(async () => ({ data: {}, error: null })),
      },
    },
  }) as AdminDb;
}

beforeEach(() => {
  mockDb = build();
});

describe('выдача ключа', () => {
  it('возвращает открытый ключ ровно один раз', async () => {
    const result = await issueBenchKey({ name: 'Дима', tools: ['yandexmaps'], createdBy: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issued.key).toMatch(/^bench_live_/);
  });

  it('в базу кладёт отпечаток, а не сам ключ', async () => {
    const result = await issueBenchKey({ name: 'Дима', tools: ['yandexmaps'], createdBy: null });
    if (!result.ok) throw new Error('ожидался успех');
    const row = mockDb.inserts.find((i) => i.table === 'bench_api_keys')!.rows[0];
    expect(row.key_hash).toBe(hashBenchKey(result.issued.key));
    expect(JSON.stringify(row)).not.toContain(result.issued.key);
  });

  it('робот заводится без роли и с флагом', async () => {
    await issueBenchKey({ name: 'Дима', tools: ['yandexmaps'], createdBy: null });
    const upsert = mockDb.upserts.find((u) => u.table === 'profiles')!;
    expect(upsert.rows[0].role).toBeNull();
    expect(upsert.rows[0].is_api_robot).toBe(true);
  });

  it('проставляет лимиты по умолчанию', async () => {
    await issueBenchKey({ name: 'Дима', tools: ['yandexmaps'], createdBy: null });
    const row = mockDb.inserts.find((i) => i.table === 'bench_api_keys')!.rows[0];
    expect(row.rpm_limit).toBe(DEFAULT_BENCH_LIMITS.rpm_limit);
    expect(row.max_active_jobs).toBe(DEFAULT_BENCH_LIMITS.max_active_jobs);
  });

  it('переданные лимиты перекрывают умолчания', async () => {
    await issueBenchKey({
      name: 'Дима',
      tools: ['yandexmaps'],
      limits: { daily_jobs_limit: 5 },
      createdBy: null,
    });
    const row = mockDb.inserts.find((i) => i.table === 'bench_api_keys')!.rows[0];
    expect(row.daily_jobs_limit).toBe(5);
    expect(row.rpm_limit).toBe(DEFAULT_BENCH_LIMITS.rpm_limit);
  });

  it('если ключ создать не удалось — робот не остаётся мусором', async () => {
    mockDb = build({ tables: { profiles: [], bench_api_keys: [] }, errorInserts: { bench_api_keys: { code: '23505', message: 'дубль' } } });
    const result = await issueBenchKey({ name: 'Дима', tools: ['yandexmaps'], createdBy: null });
    expect(result.ok).toBe(false);
    expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith(ROBOT_ID);
  });
});

describe('отзыв ключа', () => {
  it('проставляет дату, а не удаляет строку', async () => {
    mockDb = build({
      tables: { bench_api_keys: [{ id: 'k1', revoked_at: null }] },
    });
    const result = await revokeBenchKey('k1');
    expect(result.ok).toBe(true);
    // Журнал обращений ссылается на ключ: удаление строки унесло бы с собой
    // всю историю, а разбирать инцидент нужно именно по ней.
    const update = mockDb.updates.find((u) => u.table === 'bench_api_keys');
    expect(update?.patch.revoked_at).toBeTruthy();
    expect(mockDb.mutations.some((m) => m.kind === 'delete')).toBe(false);
  });

  it('повторный отзыв не переписывает дату', async () => {
    mockDb = build({ tables: { bench_api_keys: [{ id: 'k1', revoked_at: '2026-08-01T00:00:00Z' }] } });
    await revokeBenchKey('k1');
    // Фильтр is('revoked_at', null) не даёт затереть исходное время отзыва.
    expect(mockDb.getRows('bench_api_keys')[0].revoked_at).toBe('2026-08-01T00:00:00Z');
  });
});
