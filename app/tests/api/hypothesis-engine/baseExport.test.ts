/** @jest-environment node */

/**
 * Tests for GET /api/tools/hypothesis-engine/bases/[id]/export.
 *
 *   404 -> { error } when the base does not exist.
 *   409 -> { error } when the base is empty (row_count = 0) or row_count > 0
 *          but the parsed rows array is empty/missing — нет смысла отдавать
 *          CSV из одних заголовков.
 *   200 -> text/csv с BOM: заголовки = columns, разделитель ';', экранирование,
 *          Content-Disposition с безопасным (транслит) именем файла.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000001';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'admin' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
}));

import { GET } from '@/app/api/tools/hypothesis-engine/bases/[id]/export/route';

const BASE_ID = 'b1';

function makeReq(id: string = BASE_ID): NextRequest {
  return new Request(`http://x/api/tools/hypothesis-engine/bases/${id}/export`, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: BASE_ID }) };

function seedBase(row: Record<string, unknown>) {
  mockDb = createMockSupabase({
    tables: { he_bases: [{ id: BASE_ID, project_id: 'p1', ...row }] },
  });
}

describe('GET bases/[id]/export', () => {
  it('returns 404 when the base does not exist', async () => {
    mockDb = createMockSupabase({ tables: { he_bases: [] } });
    const res = await GET(makeReq('missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('База не найдена');
  });

  it('returns 409 on an empty base (row_count = 0)', async () => {
    seedBase({ filename: 'auto: HR', row_count: 0, columns: [], data: [] });
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('пустая');
  });

  it.each([null, [], 'broken'])(
    'returns 409 when row_count > 0 but data is missing/not an array (%p)',
    async (data) => {
      // row_count — только счётчик: data потеряна/битая → экспортировать
      // по факту нечего, тот же 409, что и у пустой базы.
      seedBase({ filename: 'auto: HR', row_count: 5, columns: ['company'], data });
      const res = await GET(makeReq(), params);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('пустая');
    },
  );

  it('streams a BOM-prefixed, semicolon CSV with escaped cells and a safe filename', async () => {
    seedBase({
      filename: 'auto: HR-агентства',
      row_count: 2,
      columns: ['company', 'website', 'note'],
      data: [
        { company: 'ООО "Код"; ИП', website: 'code.ru', note: 'первая\nвторая' },
        { company: 'АС', website: 'as.ru', note: '' },
      ],
    });

    const res = await GET(makeReq(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="auto-hr-agentstva.csv"',
    );

    // Сырые байты начинаются с BOM (EF BB BF — Excel-RU определяет UTF-8);
    // res.text() сам срезает BOM при декодировании, поэтому проверяем буфер.
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const lines = bytes.toString('utf-8').slice(1).split('\r\n');
    expect(lines).toEqual([
      'company;website;note',
      '"ООО ""Код""; ИП";code.ru;"первая\nвторая"',
      'АС;as.ru;',
    ]);
  });

  it('falls back to base-<id>.csv when the filename has no safe chars', async () => {
    seedBase({
      filename: '🔥',
      row_count: 1,
      columns: ['company'],
      data: [{ company: 'АС' }],
    });
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="base-b1.csv"',
    );
  });
});
