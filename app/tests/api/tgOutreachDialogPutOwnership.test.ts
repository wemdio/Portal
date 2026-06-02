/** @jest-environment node */

/**
 * Regression: PUT /api/tools/tg-outreach/dialogs/[id] should reject
 * write attempts against dialogs whose parent campaign belongs to a
 * different specialist with a clear 403, NOT the cryptic supabase error
 * "JSON object requested, multiple (or no) rows returned".
 *
 * Why this happens. Migration 20260320_0003 opened SELECT on
 * tg_outreach_dialogs to all authenticated users (cross-specialist
 * read), but UPDATE still requires c.user_id = auth.uid() on the parent
 * campaign. Without an explicit ownership check in the route, the
 * PostgREST UPDATE matched 0 rows under RLS, and `.select().single()`
 * surfaced the row-count error to the operator. They saw "не работает"
 * with no actionable explanation.
 *
 * This test asserts the route now reads campaign.user_id first via a
 * JOIN, compares to auth.user.id, and returns 403 with a Russian
 * message when they don't match.
 */

const AUTH_USER_ID = 'user-A';
const FOREIGN_USER_ID = 'user-B';
const DIALOG_ID = 'dlg-1';

/**
 * Mock chain that returns ONE row for the dialog SELECT with a nested
 * `campaign` object whose `user_id` we control per-test. UPDATE never
 * runs in the 403 case, so we don't have to model it; if the route
 * forgot the ownership pre-check it would try .update().select().single()
 * and we'd raise here.
 */
function makeBuilder(table: string, dialogRow: Record<string, unknown> | null) {
  let mode: 'select' | 'update' = 'select';
  const builder: Record<string, unknown> = {
    select: () => { mode = 'select'; return builder; },
    update: () => {
      mode = 'update';
      // Регрессионный страховой выключатель: если код почему-то всё-таки дошёл
      // до UPDATE при чужой кампании, тест должен взорваться явно — а не
      // пройти «потому что supabase вернёт ошибку и роут пробросит 500».
      throw new Error(`unexpected ${table}.update() — ownership pre-check skipped`);
    },
    eq: () => builder,
    maybeSingle: async () => ({ data: dialogRow, error: null }),
    single: async () => ({ data: dialogRow, error: null }),
    // Логирование fire-and-forget (insert в tg_outreach_logs) — не должно
    // вызываться, потому что мы возвращаем 403 до записи в лог. На всякий
    // случай мокаем как async-noop.
    insert: () => ({ then: (r: (v: unknown) => void) => r({ data: null, error: null }) }),
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  };
  void mode;
  return builder;
}

let dialogRow: Record<string, unknown> | null = null;

const supabaseMock = { from: (table: string) => makeBuilder(table, dialogRow) };

jest.mock('@/lib/tgOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({ user: { id: AUTH_USER_ID }, supabase: supabaseMock })),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_o: unknown, h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>) =>
    h({ end: async () => {}, fail: async () => {} }),
}));

import { PUT } from '@/app/api/tools/tg-outreach/dialogs/[id]/route';

function makePutReq(body: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/tools/tg-outreach/dialogs/${DIALOG_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: DIALOG_ID }) };

describe('PUT /tg-outreach/dialogs/[id] — campaign ownership pre-check', () => {
  it('returns 403 with a Russian message when the parent campaign belongs to another user', async () => {
    dialogRow = {
      can_send: false,
      campaign_id: 'camp-1',
      tg_user_id: 1234567890,
      tg_username: 'somebody',
      campaign: { user_id: FOREIGN_USER_ID },
    };

    const res = await PUT(makePutReq({ can_send: true }) as never, ctx as never);
    expect(res.status).toBe(403);
    const body = await (res as Response).json();
    expect(typeof body.error).toBe('string');
    // Сообщение должно явно объяснять причину — это и есть весь смысл фикса
    // (без него supabase возвращал «multiple (or no) rows returned»).
    expect(body.error).toMatch(/другому специалисту|только просмотр/i);
  });

  it('returns 403 when toggling status on a foreign campaign too (not only can_send)', async () => {
    dialogRow = {
      can_send: true,
      campaign_id: 'camp-1',
      tg_user_id: 1234567890,
      tg_username: 'somebody',
      campaign: { user_id: FOREIGN_USER_ID },
    };

    const res = await PUT(makePutReq({ status: 'lead' }) as never, ctx as never);
    expect(res.status).toBe(403);
  });

  it('supabase-js may return campaign join as an array — also treated as foreign correctly', async () => {
    dialogRow = {
      can_send: false,
      campaign_id: 'camp-1',
      tg_user_id: 1234567890,
      tg_username: 'somebody',
      // FK to a single parent table in supabase-js can arrive either as
      // object or as 1-element array depending on relation cardinality.
      // The route normalizes both shapes.
      campaign: [{ user_id: FOREIGN_USER_ID }],
    };

    const res = await PUT(makePutReq({ can_send: true }) as never, ctx as never);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the dialog id is not found at all', async () => {
    dialogRow = null;
    const res = await PUT(makePutReq({ can_send: true }) as never, ctx as never);
    expect(res.status).toBe(404);
  });
});
