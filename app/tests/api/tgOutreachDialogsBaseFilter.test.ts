/** @jest-environment node */

/**
 * Regression: GET /api/tools/tg-outreach/dialogs?base_id=… фильтрует через
 * функцию tg_outreach_dialogs_by_base, а не вклейкой всех контактов базы в
 * PostgREST-условие or(tg_username.in.(…),tg_user_id.in.(…)).
 *
 * Условие едет в URL запроса к базе, и на базе из 441 контакта (кампания
 * atol-1) строка фильтра разрослась до ~7,5 КБ — шлюз ответил «URI too long»,
 * и вкладка «Диалоги» падала 500-й на ровном месте. Проверяем два плеча:
 * с base_id список обязан идти в rpc c GET-режимом и ни одним or() (or()
 * остаётся для поиска по q — его в запросе нет), без base_id — прямой
 * выборкой из таблицы, как раньше.
 */

const AUTH_USER_ID = 'user-A';

let orFilters: string[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
let fromTables: string[] = [];

function makeBuilder(result: { data?: unknown[]; count?: number } = {}) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    ilike: () => builder,
    in: () => builder,
    order: () => builder,
    range: () => builder,
    or: (filter: string) => {
      orFilters.push(filter);
      return builder;
    },
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? [], error: null, count: result.count ?? (result.data ?? []).length }),
  };
  return builder;
}

const supabaseMock = {
  rpc: (fn: string, args: Record<string, unknown>, options?: Record<string, unknown>) => {
    rpcCalls.push({ fn, args, options });
    return makeBuilder();
  },
  from: (table: string) => {
    fromTables.push(table);
    return makeBuilder();
  },
};

jest.mock('@/lib/tgOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({ user: { id: AUTH_USER_ID }, supabase: supabaseMock })),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
}));

import { GET } from '@/app/api/tools/tg-outreach/dialogs/route';

function makeGetReq(query: string): Request {
  return new Request(`http://localhost/api/tools/tg-outreach/dialogs?${query}`, {
    headers: { authorization: 'Bearer test' },
  });
}

beforeEach(() => {
  orFilters = [];
  rpcCalls = [];
  fromTables = [];
});

describe('GET /tg-outreach/dialogs — фильтр по базе', () => {
  it('base_id идёт в rpc tg_outreach_dialogs_by_base с GET-режимом, без in-списка в or()', async () => {
    const res = await GET(makeGetReq('campaign_id=camp-1&limit=30&offset=0&base_id=base-1') as never);
    expect(res.status).toBe(200);

    expect(rpcCalls).toEqual([
      {
        fn: 'tg_outreach_dialogs_by_base',
        args: { p_campaign_id: 'camp-1', p_base_id: 'base-1' },
        options: { get: true, count: 'exact' },
      },
    ]);

    // Страховка от возврата к старому способу: or(tg_username.in.(…)) длиной
    // в тысячи символов — тот самый «URI too long».
    expect(orFilters).toEqual([]);
  });

  it('без base_id список идёт прямой выборкой из tg_outreach_dialogs', async () => {
    const res = await GET(makeGetReq('campaign_id=camp-1&limit=30&offset=0') as never);
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([]);
    expect(fromTables).toContain('tg_outreach_dialogs');
  });
});
