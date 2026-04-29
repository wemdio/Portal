/** @jest-environment node */

/**
 * Regression: POST /campaigns/[id]/start must NEVER reset progress on
 * existing li_campaign_leads.
 *
 * Bug seen in prod (Apr 2026): the route called
 *   db.upsert({ current_step: 0, status: 'pending' }, { onConflict: 'campaign_id,lead_id' })
 * which under Postgres upsert semantics overwrites every existing row that
 * already had a (campaign_id, lead_id) — rolling leads in `waiting` /
 * `in_progress` / `completed` back to step 0. On the next tick the runner
 * re-sent invites, LinkedIn responded `already_invited` for each, and the
 * whole pipeline ground to ~1 lead per 15 minutes.
 *
 * The fix must keep /start additive only:
 *   - existing campaign_leads → untouched (current_step, status, next_action_at preserved)
 *   - new leads in the list   → inserted as { current_step: 0, status: 'pending' }
 */

const AUTH_USER_ID = 'user-A';

interface CampaignLeadRow {
  campaign_id: string;
  lead_id: string;
  current_step: number;
  status: string;
  next_action_at: string | null;
}

const state = {
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
};

function resetState() {
  state.rowsByTable = {};
}

function makeBuilder(table: string) {
  const filters: Array<{ col: string; val: unknown }> = [];
  let mode: 'select' | 'update' | 'insert' | 'upsert' = 'select';
  let payload: unknown = null;
  let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  let inFilter: { col: string; vals: unknown[] } | null = null;

  const apply = () => {
    let rows = (state.rowsByTable[table] ?? []).slice();
    for (const f of filters) rows = rows.filter((r) => r[f.col] === f.val);
    if (inFilter) rows = rows.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
    return rows;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters.push({ col, val });
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      inFilter = { col, vals };
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    single: async () => {
      const rows = apply();
      return { data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } };
    },
    maybeSingle: async () => {
      const rows = apply();
      return { data: rows[0] ?? null, error: null };
    },
    update: (data: Record<string, unknown>) => {
      mode = 'update';
      payload = data;
      return builder;
    },
    insert: (data: unknown) => {
      mode = 'insert';
      payload = data;
      return builder;
    },
    upsert: (data: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      mode = 'upsert';
      payload = data;
      upsertOpts = opts ?? {};
      return builder;
    },
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'update') {
        const rows = apply();
        for (const r of rows) Object.assign(r, payload as Record<string, unknown>);
        resolve({ data: null, error: null });
        return;
      }
      if (mode === 'insert') {
        const arr = Array.isArray(payload) ? payload : [payload];
        state.rowsByTable[table] = (state.rowsByTable[table] ?? []).concat(
          arr as Array<Record<string, unknown>>,
        );
        resolve({ data: arr, error: null });
        return;
      }
      if (mode === 'upsert') {
        const arr = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
        const conflict = (upsertOpts.onConflict ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        const ignoreDup = !!upsertOpts.ignoreDuplicates;
        const existing = state.rowsByTable[table] ?? [];
        for (const newRow of arr) {
          const dup = existing.find((r) => conflict.every((k) => r[k] === newRow[k]));
          if (dup) {
            if (!ignoreDup) Object.assign(dup, newRow);
            continue;
          }
          existing.push(newRow);
        }
        state.rowsByTable[table] = existing;
        resolve({ data: null, error: null });
        return;
      }
      resolve({ data: apply(), error: null });
    },
  };
  return builder;
}

const fromMock = jest.fn((table: string) => makeBuilder(table));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => fromMock(table) },
}));

jest.mock('@/lib/liOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({
      user: { id: AUTH_USER_ID },
      supabase: { from: (table: string) => fromMock(table) },
    })),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _opts: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

import { NextRequest } from 'next/server';

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', ...(init?.headers ?? {}) },
    ...init,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  resetState();
  fromMock.mockClear();
});

describe('POST /campaigns/[id]/start — progress preservation', () => {
  function seed() {
    state.rowsByTable.li_campaigns = [
      { id: 'c1', user_id: AUTH_USER_ID, status: 'draft', lead_list_id: 'll1' },
    ];
    state.rowsByTable.li_leads = [
      { id: 'L1', user_id: AUTH_USER_ID, lead_list_id: 'll1' },
      { id: 'L2', user_id: AUTH_USER_ID, lead_list_id: 'll1' },
      { id: 'L3', user_id: AUTH_USER_ID, lead_list_id: 'll1' },
      { id: 'L4', user_id: AUTH_USER_ID, lead_list_id: 'll1' },
      { id: 'L5', user_id: AUTH_USER_ID, lead_list_id: 'll1' },
    ];
    state.rowsByTable.li_campaign_leads = [
      {
        campaign_id: 'c1',
        lead_id: 'L1',
        current_step: 2,
        status: 'waiting',
        next_action_at: '2026-05-01T10:00:00Z',
      },
      {
        campaign_id: 'c1',
        lead_id: 'L2',
        current_step: 1,
        status: 'in_progress',
        next_action_at: null,
      },
      {
        campaign_id: 'c1',
        lead_id: 'L3',
        current_step: 3,
        status: 'completed',
        next_action_at: null,
      },
    ];
  }

  it('does not roll back current_step / status of leads that already have a campaign_lead', async () => {
    seed();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/start/route');
    const res = await POST(makeReq('http://x/api/tools/li-outreach/campaigns/c1/start'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect((res as Response).status).toBe(200);

    const cls = state.rowsByTable.li_campaign_leads as unknown as CampaignLeadRow[];
    const byLead = Object.fromEntries(cls.map((r) => [r.lead_id, r]));

    expect(byLead.L1).toMatchObject({
      current_step: 2,
      status: 'waiting',
      next_action_at: '2026-05-01T10:00:00Z',
    });
    expect(byLead.L2).toMatchObject({ current_step: 1, status: 'in_progress' });
    expect(byLead.L3).toMatchObject({ current_step: 3, status: 'completed' });
  });

  it('inserts brand-new leads as { current_step: 0, status: pending }', async () => {
    seed();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/start/route');
    await POST(makeReq('http://x/api/tools/li-outreach/campaigns/c1/start'), {
      params: Promise.resolve({ id: 'c1' }),
    });

    const cls = state.rowsByTable.li_campaign_leads as unknown as CampaignLeadRow[];
    const byLead = Object.fromEntries(cls.map((r) => [r.lead_id, r]));

    expect(byLead.L4).toMatchObject({ current_step: 0, status: 'pending' });
    expect(byLead.L5).toMatchObject({ current_step: 0, status: 'pending' });
  });

  it('moves campaign status to running', async () => {
    seed();
    const { POST } = await import('@/app/api/tools/li-outreach/campaigns/[id]/start/route');
    await POST(makeReq('http://x/api/tools/li-outreach/campaigns/c1/start'), {
      params: Promise.resolve({ id: 'c1' }),
    });

    const c = (state.rowsByTable.li_campaigns as Array<{ id: string; status: string }>).find(
      (r) => r.id === 'c1',
    )!;
    expect(c.status).toBe('running');
  });
});
