/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { createBoardToken } from '@/lib/leadBoard/boardToken';
import { DEFAULT_COLUMN_CONFIG } from '@/lib/instantly/leadBoardWriter';

let mockInstantlyDb: MockSupabaseClient | null;

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

const SECRET = 'test-secret-123';
const PID = '11111111-2222-3333-4444-555555555555';

function makeToken(pid: string = PID): string {
  return createBoardToken(pid, SECRET);
}

function seed(token: string) {
  return createMockSupabase({
    tables: {
      project_lead_boards: [{ project_id: PID, token, column_config: DEFAULT_COLUMN_CONFIG }],
    },
  });
}

function fakeReq(body: unknown) {
  return { json: async () => body } as never;
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

async function importRoute() {
  return import('@/app/api/lead-board/[token]/config/route');
}

beforeEach(() => {
  jest.resetModules();
  process.env.GUEST_TOKEN_SECRET = SECRET;
});

describe('PATCH /api/lead-board/[token]/config', () => {
  it('скрытие builtin-колонки сохраняется в БД', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { PATCH } = await importRoute();

    const next = DEFAULT_COLUMN_CONFIG.map((c) => (c.key === 'website' ? { ...c, visible: false } : c));
    const res = await PATCH(fakeReq({ columnConfig: next }), ctx(token));
    expect(res.status).toBe(200);
    const stored = mockInstantlyDb!.getRows('project_lead_boards')[0];
    const cfg = stored.column_config as { key: string; visible: boolean }[];
    expect(cfg.find((c) => c.key === 'website')!.visible).toBe(false);
  });

  it('добавление кастомной колонки с label', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { PATCH } = await importRoute();

    const res = await PATCH(
      fakeReq({ columnConfig: [...DEFAULT_COLUMN_CONFIG, { key: 'c_inn', label: 'ИНН', visible: true, custom: true }] }),
      ctx(token),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.columnConfig).toHaveLength(DEFAULT_COLUMN_CONFIG.length + 1);
    expect(json.columnConfig.at(-1)).toMatchObject({ key: 'c_inn', label: 'ИНН', custom: true });
  });

  it('переименование и удаление кастомной колонки (значения строк не трогаются — только конфиг)', async () => {
    const token = makeToken();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_lead_boards: [
          {
            project_id: PID,
            token,
            column_config: [...DEFAULT_COLUMN_CONFIG, { key: 'c_inn', label: 'ИНН', visible: true, custom: true }],
          },
        ],
        project_lead_board_rows: [{ id: 'r-1', project_id: PID, custom: { c_inn: '123' } }],
      },
    });
    const { PATCH } = await importRoute();

    // rename
    const renamed = [...DEFAULT_COLUMN_CONFIG, { key: 'c_inn', label: 'ИНН компании', visible: true, custom: true }];
    expect((await PATCH(fakeReq({ columnConfig: renamed }), ctx(token))).status).toBe(200);
    let cfg = mockInstantlyDb!.getRows('project_lead_boards')[0].column_config as { key: string; label?: string }[];
    expect(cfg.at(-1)!.label).toBe('ИНН компании');

    // delete — строки не затрагиваются (только update boards)
    expect((await PATCH(fakeReq({ columnConfig: DEFAULT_COLUMN_CONFIG }), ctx(token))).status).toBe(200);
    cfg = mockInstantlyDb!.getRows('project_lead_boards')[0].column_config as { key: string }[];
    expect(cfg.find((c) => c.key === 'c_inn')).toBeUndefined();
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')[0].custom).toEqual({ c_inn: '123' });
  });

  it('невалидный конфиг → 400; мусорный токен → 401', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { PATCH } = await importRoute();

    expect((await PATCH(fakeReq({ columnConfig: 'oops' }), ctx(token))).status).toBe(400);
    expect((await PATCH(fakeReq({ columnConfig: [{ key: 'inn' }] }), ctx(token))).status).toBe(400);
    expect(
      (await PATCH(fakeReq({ columnConfig: DEFAULT_COLUMN_CONFIG.map((c) => ({ key: c.key, visible: false })) }), ctx(token))).status,
    ).toBe(400);
    expect((await PATCH(fakeReq({ columnConfig: DEFAULT_COLUMN_CONFIG }), ctx('garbage'))).status).toBe(401);
  });
});
