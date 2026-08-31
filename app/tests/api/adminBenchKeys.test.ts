/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const MANAGER_ID = '00000000-0000-4000-8000-000000000002';

let mockDb: MockSupabaseClient;
let actingUserId = ADMIN_ID;

const issueBenchKey = jest.fn(async (_a: unknown) => ({
  ok: true as const,
  issued: { key: 'bench_live_secret', id: 'k-new', robotUserId: 'r1' },
}));
const revokeBenchKey = jest.fn(async (_id: string) => ({ ok: true as const }));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));
jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: { getUser: jest.fn(async () => ({ data: { user: { id: actingUserId } } })) },
  }),
}));
jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));
jest.mock('@/lib/bench/issueKey', () => ({
  issueBenchKey: (a: unknown) => issueBenchKey(a),
  revokeBenchKey: (id: string) => revokeBenchKey(id),
}));

import { GET, POST } from '@/app/api/admin/bench-keys/route';
import { GET as getLog, POST as keyAction } from '@/app/api/admin/bench-keys/[id]/route';

function req(body?: unknown): NextRequest {
  return {
    headers: { get: () => 'Bearer test-token' },
    json: async () => body ?? {},
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  actingUserId = ADMIN_ID;
  issueBenchKey.mockClear();
  revokeBenchKey.mockClear();
  mockDb = createMockSupabase({
    tables: {
      profiles: [
        { id: ADMIN_ID, role: 'admin' },
        { id: MANAGER_ID, role: 'manager' },
      ],
      bench_api_keys: [
        {
          id: 'k1',
          name: 'Дима',
          key_hash: 'СЕКРЕТНЫЙ_ОТПЕЧАТОК',
          key_last4: 'ab12',
          allowed_tools: ['yandexmaps'],
          rpm_limit: 60,
          daily_jobs_limit: 50,
          daily_rows_limit: 1000,
          max_active_jobs: 3,
          revoked_at: null,
          last_used_at: null,
          created_at: '2026-08-31T10:00:00Z',
        },
      ],
      bench_api_requests: [
        {
          id: 1,
          key_id: 'k1',
          tool: 'yandexmaps',
          action: 'create_job',
          status_code: 200,
          rows_returned: 0,
          duration_ms: 42,
          created_at: '2026-08-31T10:05:00Z',
        },
      ],
    },
  });
});

describe('доступ к экрану ключей', () => {
  it('не-админа не пускает', async () => {
    actingUserId = MANAGER_ID;
    expect((await GET(req())).status).toBe(403);
    expect((await POST(req({ name: 'X', tools: ['yandexmaps'] }))).status).toBe(403);
  });

  it('не-админ не может отозвать ключ', async () => {
    actingUserId = MANAGER_ID;
    const res = await keyAction(req({ action: 'revoke' }), ctx('k1'));
    expect(res.status).toBe(403);
    expect(revokeBenchKey).not.toHaveBeenCalled();
  });
});

describe('список ключей', () => {
  it('отдаёт ключи и каталог инструментов', async () => {
    const body = await (await GET(req())).json();
    expect(body.keys).toHaveLength(1);
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('не отдаёт отпечаток ключа в браузер', async () => {
    const body = await (await GET(req())).json();
    // Ответ собирается перечислением полей, поэтому отпечаток не уедет даже
    // если запрос к базе однажды заменят на select('*').
    expect(body.keys[0].key_hash).toBeUndefined();
    expect(JSON.stringify(body.keys)).not.toContain('СЕКРЕТНЫЙ_ОТПЕЧАТОК');
  });

  it('и не спрашивает отпечаток у базы', async () => {
    await GET(req());
    const projection = mockDb.selects.find((s) => s.table === 'bench_api_keys')?.columns ?? '';
    expect(projection).not.toContain('key_hash');
    expect(projection).not.toContain('*');
  });
});

describe('выдача ключа', () => {
  it('возвращает открытый ключ один раз', async () => {
    const body = await (await POST(req({ name: 'Дима', tools: ['yandexmaps'] }))).json();
    expect(body.key).toBe('bench_live_secret');
  });

  it('без инструментов не выдаёт', async () => {
    const res = await POST(req({ name: 'Дима', tools: [] }));
    expect(res.status).toBe(400);
    expect(issueBenchKey).not.toHaveBeenCalled();
  });

  it('выдуманный инструмент отвергает, а не выдаёт молча', async () => {
    // Иначе на экране он выглядел бы выданным, а работать бы не стал.
    const res = await POST(req({ name: 'Дима', tools: ['выдуманный'] }));
    expect(res.status).toBe(400);
    expect(issueBenchKey).not.toHaveBeenCalled();
  });

  it('запоминает, кто выдал', async () => {
    await POST(req({ name: 'Дима', tools: ['yandexmaps'] }));
    expect(issueBenchKey).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: ADMIN_ID }),
    );
  });
});

describe('отзыв и журнал', () => {
  it('отзывает ключ', async () => {
    const res = await keyAction(req({ action: 'revoke' }), ctx('k1'));
    expect(res.status).toBe(200);
    expect(revokeBenchKey).toHaveBeenCalledWith('k1');
  });

  it('другого действия над ключом нет', async () => {
    const res = await keyAction(req({ action: 'edit' }), ctx('k1'));
    expect(res.status).toBe(400);
    expect(revokeBenchKey).not.toHaveBeenCalled();
  });

  it('отдаёт журнал по ключу', async () => {
    const body = await (await getLog(req(), ctx('k1'))).json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].action).toBe('create_job');
  });
});
