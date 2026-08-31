/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient | null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { logBenchRequest } from '@/lib/bench/journal';

const ENTRY = {
  keyId: 'k1',
  tool: 'yandexmaps',
  action: 'create_job',
  statusCode: 200,
  rowsReturned: 0,
  durationMs: 42,
};

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: { bench_api_requests: [], bench_api_keys: [{ id: 'k1', last_used_at: null }] },
  });
});

describe('журнал', () => {
  it('пишет обращение', async () => {
    await logBenchRequest(ENTRY);
    const inserts = mockDb!.inserts.filter((i) => i.table === 'bench_api_requests');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows[0]).toMatchObject({
      key_id: 'k1',
      action: 'create_job',
      status_code: 200,
    });
  });

  it('не пишет тела запросов — в строке журнала только метаданные', async () => {
    // Никаких полей сверх этого списка. Если кто-то захочет «на всякий
    // случай» приложить к записи параметры запроса, тест это остановит:
    // в параметрах приходят базы клиентов.
    const ALLOWED = ['action', 'duration_ms', 'key_id', 'rows_returned', 'status_code', 'tool'];

    await logBenchRequest(ENTRY);
    const row = mockDb!.inserts.find((i) => i.table === 'bench_api_requests')!.rows[0];
    // `id` подставляет сам мок (в базе это bigserial) — он не из нашего кода.
    const written = Object.keys(row).filter((k) => k !== 'id');
    expect(written.sort()).toEqual(ALLOWED);
  });

  it('отмечает время последнего использования ключа', async () => {
    await logBenchRequest(ENTRY);
    expect(mockDb!.updates.some((u) => u.table === 'bench_api_keys')).toBe(true);
  });

  it('падение журнала не роняет запрос', async () => {
    mockDb = null;
    await expect(logBenchRequest(ENTRY)).resolves.toBeUndefined();
  });
});
