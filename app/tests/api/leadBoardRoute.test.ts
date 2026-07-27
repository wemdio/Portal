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

  it('попытка записать несуществующее поле → 400 с именем поля', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { PATCH } = await importRoute();
    const res = await PATCH(
      fakeReq({ rowId: 'row-1', quality: 'ответил', hacked_field: 'x' }),
      ctx(token),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/hacked_field/);
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

describe('PATCH расширенный: авто-поля, шаг, дата, custom', () => {
  function seedWithCustom() {
    const token = makeToken();
    const db = createMockSupabase({
      tables: {
        project_lead_boards: [
          {
            project_id: PID,
            token,
            column_config: [{ key: 'c_inn', label: 'ИНН', visible: true, custom: true }],
          },
        ],
        project_lead_board_rows: [
          { id: 'row-1', project_id: PID, lead_email: 'a@b.ru', custom: { c_inn: '111' }, taken: false },
        ],
      },
    });
    return { token, db };
  }

  it('редактирование авто-полей (email, имя, телефон) сохраняется', async () => {
    const { token, db } = seedWithCustom();
    mockInstantlyDb = db;
    const { PATCH } = await importRoute();
    const res = await PATCH(
      fakeReq({ rowId: 'row-1', lead_email: 'new@corp.ru', lead_name: 'Пётр', phone: '8999' }),
      ctx(token),
    );
    expect(res.status).toBe(200);
    const stored = db.getRows('project_lead_board_rows')[0];
    expect(stored).toMatchObject({ lead_email: 'new@corp.ru', lead_name: 'Пётр', phone: '8999' });
  });

  it('step_number: валидный int → сохраняется; 0/дробь/строка → 400', async () => {
    const { token, db } = seedWithCustom();
    mockInstantlyDb = db;
    const { PATCH } = await importRoute();
    expect((await PATCH(fakeReq({ rowId: 'row-1', step_number: 3 }), ctx(token))).status).toBe(200);
    expect(db.getRows('project_lead_board_rows')[0].step_number).toBe(3);
    expect((await PATCH(fakeReq({ rowId: 'row-1', step_number: 0 }), ctx(token))).status).toBe(400);
    expect((await PATCH(fakeReq({ rowId: 'row-1', step_number: 2.5 }), ctx(token))).status).toBe(400);
    expect((await PATCH(fakeReq({ rowId: 'row-1', step_number: '3' }), ctx(token))).status).toBe(400);
  });

  it('reply_timestamp: «25.07.2026» → ISO; мусор → 400', async () => {
    const { token, db } = seedWithCustom();
    mockInstantlyDb = db;
    const { PATCH } = await importRoute();
    const res = await PATCH(fakeReq({ rowId: 'row-1', reply_timestamp: '25.07.2026' }), ctx(token));
    expect(res.status).toBe(200);
    expect(Date.parse(db.getRows('project_lead_board_rows')[0].reply_timestamp as string)).toBe(
      Date.UTC(2026, 6, 25),
    );
    expect((await PATCH(fakeReq({ rowId: 'row-1', reply_timestamp: 'вчера' }), ctx(token))).status).toBe(400);
  });

  it('custom: мерж по ключу, удаление null, неизвестный ключ → 400', async () => {
    const { token, db } = seedWithCustom();
    mockInstantlyDb = db;
    const { PATCH } = await importRoute();
    // мерж: другое поле в custom сохраняется, новое добавляется
    const res = await PATCH(fakeReq({ rowId: 'row-1', custom: { c_inn: '999888' } }), ctx(token));
    expect(res.status).toBe(200);
    expect(db.getRows('project_lead_board_rows')[0].custom).toEqual({ c_inn: '999888' });
    // удаление значения через null
    expect((await PATCH(fakeReq({ rowId: 'row-1', custom: { c_inn: null } }), ctx(token))).status).toBe(200);
    expect(db.getRows('project_lead_board_rows')[0].custom).toEqual({});
    // ключ не из конфига доски
    expect((await PATCH(fakeReq({ rowId: 'row-1', custom: { c_evil: 'x' } }), ctx(token))).status).toBe(400);
  });
});

describe('POST/DELETE строки', () => {
  it('POST создаёт пустую строку проекта', async () => {
    const token = makeToken();
    mockInstantlyDb = seedInstantly(token);
    const { POST } = await importRoute();
    const res = await POST(fakeReq({}), ctx(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const rows = mockInstantlyDb!.getRows('project_lead_board_rows');
    expect(rows.some((r) => r.id === json.id && r.project_id === PID)).toBe(true);
  });

  it('DELETE удаляет свою строку; чужая → 404 и остаётся', async () => {
    const token = makeToken();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_lead_boards: [{ project_id: PID, token, column_config: [] }],
        project_lead_board_rows: [
          { id: 'row-mine', project_id: PID, lead_email: 'a@b.ru' },
          { id: 'row-alien', project_id: 'ffffffff-0000-0000-0000-000000000000', lead_email: 'x@y.ru' },
        ],
      },
    });
    const { DELETE } = await importRoute();

    expect((await DELETE(fakeReq({ rowId: 'row-mine' }), ctx(token))).status).toBe(200);
    expect((await DELETE(fakeReq({ rowId: 'row-alien' }), ctx(token))).status).toBe(404);
    const rows = mockInstantlyDb!.getRows('project_lead_board_rows');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('row-alien');
  });
});
