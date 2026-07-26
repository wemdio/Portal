/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { createBoardToken } from '@/lib/leadBoard/boardToken';
import { LEAD_QUALITY_OPTIONS } from '@/lib/leadBoard/leadQuality';

let mockInstantlyDb: MockSupabaseClient | null;
let mockMainDb: MockSupabaseClient | null;

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));
jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

const SECRET = 'test-secret-123';
const PID = '11111111-2222-3333-4444-555555555555';

const ROW_1 = {
  id: 'row-1',
  project_id: PID,
  qualification_id: 'q-1',
  lead_email: 'office@vergiz.ru',
  lead_name: 'Алексей',
  company_name: 'ВЕРГИЗ',
  phone: '89060571212',
  website: 'vergiz.ru',
  request_text: 'Напишите в Макс Алексей!',
  campaign_name: 'Вакансия:Логист',
  step_number: 1,
  reply_timestamp: new Date().toISOString(),
  quality: null,
  comment: null,
  taken: false,
};
const ROW_2 = {
  id: 'row-2',
  project_id: PID,
  qualification_id: 'q-2',
  lead_email: 'info@animal-trd.ru',
  lead_name: null,
  company_name: 'Animal Trade',
  phone: null,
  website: null,
  request_text: 'Позвонить ей',
  campaign_name: 'Asti Group',
  step_number: 2,
  reply_timestamp: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), // 10 дней назад
  quality: 'не отвечает',
  comment: 'направили предложение',
  taken: false,
};

function makeToken(pid: string = PID): string {
  return createBoardToken(pid, SECRET);
}

function seedInstantly(token: string | null) {
  return createMockSupabase({
    tables: {
      project_lead_boards: token
        ? [{ project_id: PID, token, column_config: [{ key: 'phone', visible: true }] }]
        : [],
      project_lead_board_rows: [structuredClone(ROW_1), structuredClone(ROW_2)],
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
  return import('@/app/api/lead-board/[token]/route');
}

beforeEach(() => {
  jest.resetModules();
  process.env.GUEST_TOKEN_SECRET = SECRET;
  mockMainDb = createMockSupabase({
    tables: { projects: [{ id: PID, name: 'АДК Транс', client: 'АДК Транс' }] },
  });
});

describe('GET /api/lead-board/[token]', () => {
  it('валидный токен → проект, ряды, статистика, конфиг, список статусов', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { GET } = await importRoute();

    const res = await GET(fakeReq(undefined), ctx(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.project).toEqual({ name: 'АДК Транс', client: 'АДК Транс' });
    expect(json.rows).toHaveLength(2);
    expect(json.columnConfig).toEqual([{ key: 'phone', visible: true }]);
    expect(json.qualities).toEqual(LEAD_QUALITY_OPTIONS);
    expect(json.stats.total).toBe(2);
    expect(json.stats.last7d).toBe(1); // ROW_2 десятидневной давности
    expect(json.stats.byQuality).toEqual({ 'без оценки': 1, 'не отвечает': 1 });
    expect(json.stats.byCampaign).toEqual({ 'Вакансия:Логист': 1, 'Asti Group': 1 });
  });

  it('мусорный токен → 401', async () => {
    mockInstantlyDb = seedInstantly(makeToken());
    const { GET } = await importRoute();
    const res = await GET(fakeReq(undefined), ctx('garbage'));
    expect(res.status).toBe(401);
  });

  it('валидная подпись, но токен ≠ сохранённому (отозван) → 401', async () => {
    const oldToken = makeToken(); // в БД старый
    const newToken = makeToken(); // запрос с новым (другой nonce)
    mockInstantlyDb = seedInstantly(oldToken);
    const { GET } = await importRoute();
    const res = await GET(fakeReq(undefined), ctx(newToken));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/revoked/i);
  });

  it('проект токена без доски → 401', async () => {
    const token = makeToken('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    mockInstantlyDb = seedInstantly(null);
    const { GET } = await importRoute();
    const res = await GET(fakeReq(undefined), ctx(token));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/lead-board/[token]', () => {
  it('правка quality/comment/taken сохраняется, авто-поля не тронуты', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { PATCH } = await importRoute();

    const res = await PATCH(
      fakeReq({ rowId: 'row-1', quality: 'есть интерес', comment: 'созвониться во вторник', taken: true }),
      ctx(token),
    );
    expect(res.status).toBe(200);
    const stored = mockInstantlyDb!.getRows('project_lead_board_rows').find((r) => r.id === 'row-1')!;
    expect(stored.quality).toBe('есть интерес');
    expect(stored.comment).toBe('созвониться во вторник');
    expect(stored.taken).toBe(true);
    expect(stored.lead_email).toBe('office@vergiz.ru'); // авто-поле как было
    // обновление строго по id+project_id
    const upd = mockInstantlyDb!.updates.find((u) => u.table === 'project_lead_board_rows')!;
    expect(upd.filters).toEqual(
      expect.arrayContaining([
        { column: 'id', op: 'eq', value: 'row-1' },
        { column: 'project_id', op: 'eq', value: PID },
      ]),
    );
  });

  it('невалидное quality → 400', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { PATCH } = await importRoute();
    const res = await PATCH(fakeReq({ rowId: 'row-1', quality: 'горячий!!!' }), ctx(token));
    expect(res.status).toBe(400);
  });

  it('попытка записать авто-колонку (lead_email) → 400', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { PATCH } = await importRoute();
    const res = await PATCH(
      fakeReq({ rowId: 'row-1', quality: 'ответил', lead_email: 'hacker@evil.ru' }),
      ctx(token),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/lead_email/);
  });

  it('comment длиннее 2000 → обрезается до 2000', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { PATCH } = await importRoute();
    const res = await PATCH(fakeReq({ rowId: 'row-1', comment: 'x'.repeat(5000) }), ctx(token));
    expect(res.status).toBe(200);
    const stored = mockInstantlyDb!.getRows('project_lead_board_rows').find((r) => r.id === 'row-1')!;
    expect((stored.comment as string).length).toBe(2000);
  });

  it('ряд ЧУЖОГО проекта этим токеном → 404 и без обновления', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_lead_boards: [{ project_id: PID, token, column_config: [] }],
        project_lead_board_rows: [
          { ...structuredClone(ROW_1), id: 'row-alien', project_id: 'ffffffff-0000-0000-0000-000000000000' },
        ],
      },
    });
    const { PATCH } = await importRoute();
    const res = await PATCH(fakeReq({ rowId: 'row-alien', taken: true }), ctx(token));
    expect(res.status).toBe(404);
    const stored = mockInstantlyDb!.getRows('project_lead_board_rows')[0];
    expect(stored.taken).toBe(false);
  });

  it('пустой PATCH (нет editable полей) → 400; мусорный токен → 401', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { PATCH } = await importRoute();
    expect((await PATCH(fakeReq({ rowId: 'row-1' }), ctx(token))).status).toBe(400);
    expect((await PATCH(fakeReq({ rowId: 'row-1', taken: true }), ctx('garbage'))).status).toBe(401);
  });
});
