/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient, type Row } from '@/../tests/helpers/mockSupabase';
import { DEFAULT_COLUMN_CONFIG } from '@/lib/instantly/leadBoardWriter';

let mockInstantlyDb: MockSupabaseClient | null;

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

const PID = '11111111-2222-3333-4444-555555555555';

function fakeReq(body: unknown) {
  return { json: async () => body } as never;
}

function ctx(id: string = PID) {
  return { params: Promise.resolve({ id }) };
}

async function importRoute() {
  return import('@/app/api/projects/[id]/lead-board/route');
}

beforeEach(() => {
  jest.resetModules();
  process.env.GUEST_TOKEN_SECRET = 'test-secret';
  process.env.PORTAL_PUBLIC_URL = 'https://app.outreachos.pro';
});

describe('GET /api/projects/[id]/lead-board', () => {
  it('доски нет → лениво создаёт и возвращает ссылку + дефолтный конфиг 12 колонок', async () => {
    mockInstantlyDb = createMockSupabase({ tables: { project_lead_boards: [] } });
    const { GET } = await importRoute();

    const res = await GET(fakeReq(undefined), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.link).toMatch(/^https:\/\/app\.outreachos\.pro\/leads-board\/lb_/);
    expect(json.columnConfig).toEqual(DEFAULT_COLUMN_CONFIG);
    expect(mockInstantlyDb!.inserts.filter((i) => i.table === 'project_lead_boards')).toHaveLength(1);
  });

  it('доска есть → возвращает её ссылку и конфиг, ничего не создаёт', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_lead_boards: [
          { project_id: PID, token: 'lb_stored.sig', column_config: [{ key: 'phone', visible: false }] },
        ],
      },
    });
    const { GET } = await importRoute();

    const res = await GET(fakeReq(undefined), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.link).toBe('https://app.outreachos.pro/leads-board/lb_stored.sig');
    expect(json.columnConfig).toEqual([{ key: 'phone', visible: false }]);
    expect(mockInstantlyDb!.inserts.filter((i) => i.table === 'project_lead_boards')).toHaveLength(0);
  });
});

describe('POST /api/projects/[id]/lead-board (regenerate)', () => {
  it('регенерирует токен: в БД новый, ссылка с новым, старый не совпадает', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: { project_lead_boards: [{ project_id: PID, token: 'lb_old.sig', column_config: [] }] },
    });
    const { POST } = await importRoute();

    const res = await POST(fakeReq({ action: 'regenerate' }), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.link).toMatch(/^https:\/\/app\.outreachos\.pro\/leads-board\/lb_/);
    const stored = mockInstantlyDb!.getRows('project_lead_boards')[0] as Row;
    expect(stored.token).not.toBe('lb_old.sig');
    expect(json.link).toContain(stored.token);
    // update строго по проекту
    const upd = mockInstantlyDb!.updates.find((u) => u.table === 'project_lead_boards')!;
    expect(upd.filters).toEqual(expect.arrayContaining([{ column: 'project_id', op: 'eq', value: PID }]));
  });

  it('доски ещё нет → regenerate лениво создаёт и сразу ротирует', async () => {
    mockInstantlyDb = createMockSupabase({ tables: { project_lead_boards: [] } });
    const { POST } = await importRoute();
    const res = await POST(fakeReq({ action: 'regenerate' }), ctx());
    expect(res.status).toBe(200);
    expect(mockInstantlyDb!.getRows('project_lead_boards')).toHaveLength(1);
  });

  it('неверный action / null-боди → 400', async () => {
    mockInstantlyDb = createMockSupabase({ tables: { project_lead_boards: [] } });
    const { POST } = await importRoute();
    expect((await POST(fakeReq({ action: 'delete' }), ctx())).status).toBe(400);
    expect((await POST(fakeReq(null), ctx())).status).toBe(400);
  });
});

describe('PATCH /api/projects/[id]/lead-board (columnConfig)', () => {
  function seedBoard() {
    return createMockSupabase({
      tables: { project_lead_boards: [{ project_id: PID, token: 'lb_x.sig', column_config: [] }] },
    });
  }

  it('поднабор мержится с дефолтом: порядок дефолтный, phone скрыт, остальные видимы', async () => {
    mockInstantlyDb = seedBoard();
    const { PATCH } = await importRoute();

    const res = await PATCH(fakeReq({ columnConfig: [{ key: 'phone', visible: false }] }), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.columnConfig).toHaveLength(DEFAULT_COLUMN_CONFIG.length);
    expect(json.columnConfig.map((c: { key: string }) => c.key)).toEqual(
      DEFAULT_COLUMN_CONFIG.map((c) => c.key),
    );
    expect(json.columnConfig.find((c: { key: string }) => c.key === 'phone').visible).toBe(false);
    expect(json.columnConfig.find((c: { key: string }) => c.key === 'email').visible).toBe(true);
    const stored = mockInstantlyDb!.getRows('project_lead_boards')[0] as Row;
    expect(stored.column_config).toHaveLength(DEFAULT_COLUMN_CONFIG.length);
  });

  it('не-массив / null-боди → 400', async () => {
    mockInstantlyDb = seedBoard();
    const { PATCH } = await importRoute();
    expect((await PATCH(fakeReq({ columnConfig: 'oops' }), ctx())).status).toBe(400);
    expect((await PATCH(fakeReq(null), ctx())).status).toBe(400);
  });

  it('неизвестный ключ колонки → 400 с именем ключа', async () => {
    mockInstantlyDb = seedBoard();
    const { PATCH } = await importRoute();
    const res = await PATCH(fakeReq({ columnConfig: [{ key: 'inn', visible: true }] }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/inn/);
  });

  it('все колонки скрыты → 400 (минимум одна видимая)', async () => {
    mockInstantlyDb = seedBoard();
    const { PATCH } = await importRoute();
    const res = await PATCH(
      fakeReq({ columnConfig: DEFAULT_COLUMN_CONFIG.map((c) => ({ key: c.key, visible: false })) }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least one column/i);
  });
});
