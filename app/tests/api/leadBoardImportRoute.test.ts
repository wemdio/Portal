/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient, type Row } from '@/../tests/helpers/mockSupabase';
import { createBoardToken } from '@/lib/leadBoard/boardToken';
import * as XLSX from 'xlsx';

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

function seed(token: string, existingRows: Row[] = []) {
  return createMockSupabase({
    tables: {
      project_lead_boards: [{ project_id: PID, token, column_config: [] }],
      project_lead_board_rows: existingRows,
    },
  });
}

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/csv' });
}

function reqWithFile(file: File) {
  const form = new FormData();
  form.append('file', file);
  return { formData: async () => form } as never;
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

async function importRoute() {
  return import('@/app/api/lead-board/[token]/import/route');
}

const HEADER = 'Контакт,Email,Имя,Организация,Сайт,Запрос клиента,Качество лида,Комментарий,Из какой кампании,После какого письма пришел лид,Дата лида,Взяли в работу';

beforeEach(() => {
  jest.resetModules();
  process.env.GUEST_TOKEN_SECRET = SECRET;
});

describe('POST /api/lead-board/[token]/import', () => {
  it('импортирует CSV: строки в БД с клиентскими колонками из файла', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { POST } = await importRoute();

    const csv = `${HEADER}
89060571212,office@vergiz.ru,Алексей,ВЕРГИЗ,vergiz.ru,Напишите Алексей!,ответил,созвонились,Вакансия:Логист,1,02/07/2026,TRUE`;
    const res = await POST(reqWithFile(csvFile('leads.csv', csv)), ctx(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.imported).toBe(1);
    expect(json.skipped).toHaveLength(0);

    const rows = mockInstantlyDb!.getRows('project_lead_board_rows');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: PID,
      lead_email: 'office@vergiz.ru',
      lead_name: 'Алексей',
      company_name: 'ВЕРГИЗ',
      phone: '89060571212',
      quality: 'ответил',
      comment: 'созвонились',
      campaign_name: 'Вакансия:Логист',
      step_number: 1,
      taken: true,
    });
    expect(rows[0].qualification_id ?? null).toBeNull(); // импорт — без квалификации
  });

  it('дедуп: email уже на доске → дубликат в skipped, повторно не вставляется', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token, [
      { id: 'r-1', project_id: PID, lead_email: 'office@vergiz.ru', qualification_id: 'q-1' },
    ]);
    const { POST } = await importRoute();

    const csv = `${HEADER}
89060571212,office@vergiz.ru,Алексей,ВЕРГИЗ,vergiz.ru,Текст,ответил,,Камп,1,02/07/2026,FALSE
89001112233,new@corp.ru,Пётр,Корп,corp.ru,Текст2,,,Камп,2,03/07/2026,FALSE`;
    const res = await POST(reqWithFile(csvFile('leads.csv', csv)), ctx(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.imported).toBe(1);
    expect(json.skipped).toHaveLength(1);
    expect(json.skipped[0].reason).toMatch(/дубликат/);
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')).toHaveLength(2);
  });

  it('импортирует xlsx', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { POST } = await importRoute();

    const aoa = [
      ['Email', 'Имя', 'Качество лида'],
      ['x@y.ru', 'Мария', 'есть интерес'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Лиды');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const res = await POST(reqWithFile(new File([new Uint8Array(buf)], 'leads.xlsx')), ctx(token));
    expect(res.status).toBe(200);
    expect((await res.json()).imported).toBe(1);
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')[0]).toMatchObject({
      lead_email: 'x@y.ru',
      quality: 'есть интерес',
    });
  });

  it('нет файла → 400; пустой CSV без знакомых колонок → 400; мусорный токен → 401', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { POST } = await importRoute();

    expect((await POST(reqWithFile(csvFile('empty.csv', 'foo,bar\n1,2')), ctx(token))).status).toBe(400);
    expect((await POST({ formData: async () => new FormData() } as never, ctx(token))).status).toBe(400);
    expect((await POST(reqWithFile(csvFile('l.csv', `${HEADER}\n8,a@b.ru,,,,,,,,,,`)), ctx('garbage'))).status).toBe(401);
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')).toHaveLength(0);
  });

  it('строка с данными, но без email и контакта → skipped, не падает импорт остальных', async () => {
    const token = makeToken();
    mockInstantlyDb = seed(token);
    const { POST } = await importRoute();

    const csv = `${HEADER}
,,Иван Безконтактный,,,,,,,,,
89060571212,office@vergiz.ru,Алексей,ВЕРГИЗ,vergiz.ru,Текст,ответил,,Камп,1,02/07/2026,FALSE`;
    const res = await POST(reqWithFile(csvFile('leads.csv', csv)), ctx(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.imported).toBe(1);
    expect(json.skipped).toEqual([{ index: 1, reason: 'нет email и контакта' }]);
  });
});
