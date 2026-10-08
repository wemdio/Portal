/** @jest-environment node */

/**
 * Regression: PUT /api/tools/tg-outreach/dialogs/[id] must let ANY team member
 * change the status / can_send of a dialog, whoever owns its campaign.
 *
 * Migration 20260807_0004 opened writes on tg_outreach_dialogs to everyone
 * (outreach is run by the team, a campaign has several operators), but the
 * route kept its own "campaign.user_id === auth.user.id" pre-check and
 * answered 403 «Кампания принадлежит другому специалисту — только просмотр».
 * 08.10.2026 that blocked marking leads in the campaigns of a specialist who
 * had left the company. This test fails if an owner gate comes back.
 */

const AUTH_USER_ID = 'user-A';
const DIALOG_ID = 'dlg-1';

const updates: Array<Record<string, unknown>> = [];

/**
 * Mock chain: SELECT returns the dialog row we control per-test; UPDATE
 * records its payload and returns the row merged with it.
 */
function makeBuilder(dialogRow: Record<string, unknown> | null) {
  let pending: Record<string, unknown> | null = null;
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: (patch: Record<string, unknown>) => {
      pending = patch;
      updates.push(patch);
      return builder;
    },
    eq: () => builder,
    maybeSingle: async () => ({ data: dialogRow, error: null }),
    single: async () => ({ data: { ...(dialogRow ?? {}), ...(pending ?? {}) }, error: null }),
    // Лог смены can_send пишется fire-and-forget в tg_outreach_logs.
    insert: () => ({ then: (r: (v: unknown) => void) => r({ data: null, error: null }) }),
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  };
  return builder;
}

let dialogRow: Record<string, unknown> | null = null;

const supabaseMock = { from: () => makeBuilder(dialogRow) };

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

/** A dialog of a campaign the caller does not own — the route must not care. */
function foreignDialog(canSend: boolean): Record<string, unknown> {
  return { can_send: canSend, campaign_id: 'camp-of-user-B', tg_user_id: 1234567890, tg_username: 'somebody' };
}

beforeEach(() => {
  updates.length = 0;
});

describe('PUT /tg-outreach/dialogs/[id] — any team member may edit', () => {
  it('marks a dialog of someone else’s campaign as a lead and records who did it', async () => {
    dialogRow = foreignDialog(true);

    const res = await PUT(makePutReq({ status: 'lead' }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: 'lead', lead_source: 'manual', lead_marked_by: AUTH_USER_ID });
  });

  it('toggles can_send on someone else’s campaign and records who did it', async () => {
    dialogRow = foreignDialog(false);

    const res = await PUT(makePutReq({ can_send: true }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ can_send: true, can_send_changed_by: AUTH_USER_ID, can_send_changed_reason: 'manual' });
  });

  it('returns 404 when the dialog id is not found at all', async () => {
    dialogRow = null;
    const res = await PUT(makePutReq({ can_send: true }) as never, ctx as never);
    expect(res.status).toBe(404);
  });
});
