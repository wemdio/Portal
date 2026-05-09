/** @jest-environment node */

/**
 * Coverage for the client ↔ manager support chat surface introduced May 2026.
 *
 * Targets four regression risks:
 *
 *   1. Auth boundary — both /api/client/support/* and /api/admin/support/*
 *      reject unauthenticated callers with 4xx.
 *   2. RBAC — a client who provides valid bearer cannot reach the admin
 *      endpoints; admin endpoints reject non-(admin|technician) profiles.
 *   3. Notification fanout — a client message inserts one notifications row
 *      per active manager and excludes the client themselves.
 *   4. Manager reply — a manager reply inserts exactly one notification for
 *      the thread's owning client.
 *
 * The mock layer follows the patterns in clientPortalSmoke.test.ts (chainable
 * supabase builder + jest.mock for auth helpers).
 */

import type { NextRequest } from 'next/server';

// ── Configurable auth state ──────────────────────────────────────────────────

interface ClientAuthState {
  authed: boolean;
  userId: string;
  errorStatus: number;
  errorMessage: string;
}

interface ManagerAuthState {
  authed: boolean;
  userId: string;
  role: 'admin' | 'technician' | 'client' | null;
  errorStatus: number;
  errorMessage: string;
}

const clientAuthState: ClientAuthState = {
  authed: true,
  userId: 'client-A',
  errorStatus: 401,
  errorMessage: 'Unauthorized',
};

const managerAuthState: ManagerAuthState = {
  authed: true,
  userId: 'manager-X',
  role: 'admin',
  errorStatus: 401,
  errorMessage: 'Unauthorized',
};

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => {
      if (!clientAuthState.authed) {
        return {
          error: NextResponse.json(
            { error: clientAuthState.errorMessage },
            { status: clientAuthState.errorStatus },
          ),
        };
      }
      return {
        auth: { userId: clientAuthState.userId, accessRows: [] },
      };
    }),
  };
});

jest.mock('@/lib/adminApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireAdminAuth: jest.fn(async () => ({ auth: { user: { id: managerAuthState.userId } } })),
    requireSupportManagerAuth: jest.fn(async () => {
      if (!managerAuthState.authed) {
        return {
          error: NextResponse.json(
            { error: managerAuthState.errorMessage },
            { status: managerAuthState.errorStatus },
          ),
        };
      }
      // Mirror the production behaviour: only admin/technician are allowed.
      if (managerAuthState.role !== 'admin' && managerAuthState.role !== 'technician') {
        return {
          error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
        };
      }
      return {
        auth: {
          user: { id: managerAuthState.userId },
          role: managerAuthState.role,
        },
      };
    }),
  };
});

// ── In-memory supabase replacement ───────────────────────────────────────────

interface MockRow {
  [k: string]: unknown;
}

const dbState = {
  threads: [] as MockRow[],
  messages: [] as MockRow[],
  notifications: [] as MockRow[],
  profiles: [] as MockRow[],
  insertCalls: [] as Array<{ table: string; payload: MockRow | MockRow[] }>,
  updateCalls: [] as Array<{ table: string; eqs: Record<string, unknown>; payload: MockRow }>,
};

function resetDb() {
  dbState.threads = [];
  dbState.messages = [];
  dbState.notifications = [];
  dbState.profiles = [];
  dbState.insertCalls = [];
  dbState.updateCalls = [];
}

function tableRows(name: string): MockRow[] {
  switch (name) {
    case 'client_support_threads':
      return dbState.threads;
    case 'client_support_messages':
      return dbState.messages;
    case 'notifications':
      return dbState.notifications;
    case 'profiles':
      return dbState.profiles;
    default:
      return [];
  }
}

interface BuilderState {
  table: string;
  eqs: Record<string, unknown>;
  ins: Record<string, unknown[]>;
}

function makeBuilder(table: string) {
  const state: BuilderState = { table, eqs: {}, ins: {} };

  const finalize = () => {
    let rows = tableRows(state.table).slice();
    for (const [col, val] of Object.entries(state.eqs)) {
      rows = rows.filter((r) => r[col] === val);
    }
    for (const [col, vals] of Object.entries(state.ins)) {
      rows = rows.filter((r) => vals.includes(r[col]));
    }
    return rows;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      state.eqs[col] = val;
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      state.ins[col] = vals;
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    single: async () => {
      const rows = finalize();
      const first = rows[0] ?? null;
      return { data: first, error: first ? null : { message: 'not found' } };
    },
    maybeSingle: async () => {
      const rows = finalize();
      return { data: rows[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: finalize(), error: null });
    },
    insert: (payload: MockRow | MockRow[]) => {
      dbState.insertCalls.push({ table: state.table, payload });
      const arr = Array.isArray(payload) ? payload : [payload];
      const list = tableRows(state.table);
      const inserted: MockRow[] = [];
      for (const item of arr) {
        const row: MockRow = {
          id: `${state.table}-row-${list.length + inserted.length + 1}`,
          created_at: new Date().toISOString(),
          ...item,
        };
        inserted.push(row);
        list.push(row);
      }
      // Default insert returns nothing useful unless .select().single() chains;
      // but mark "single" payload for that case.
      const insertSelf = {
        ...builder,
        select: () => insertSelf,
        single: async () => ({ data: inserted[0] ?? null, error: null }),
      };
      return insertSelf;
    },
    update: (payload: MockRow) => {
      const updateSelf = {
        ...builder,
        eq: (col: string, val: unknown) => {
          state.eqs[col] = val;
          return updateSelf;
        },
      };
      // Defer the actual update apply until then() / await on the chain.
      Object.assign(updateSelf, {
        then: (resolve: (v: unknown) => void) => {
          const rows = tableRows(state.table);
          let touched = 0;
          for (const r of rows) {
            let match = true;
            for (const [col, val] of Object.entries(state.eqs)) {
              if (r[col] !== val) {
                match = false;
                break;
              }
            }
            if (!match) continue;
            Object.assign(r, payload);
            touched += 1;
          }
          dbState.updateCalls.push({ table: state.table, eqs: { ...state.eqs }, payload });
          resolve({ data: null, error: null, count: touched });
        },
      });
      return updateSelf;
    },
  };

  return builder;
}

const adminFromMock = jest.fn((table: string) => makeBuilder(table));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => adminFromMock(table) },
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(url: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  resetDb();
  // Default: caller is an authed client.
  clientAuthState.authed = true;
  clientAuthState.userId = 'client-A';
  managerAuthState.authed = true;
  managerAuthState.userId = 'manager-X';
  managerAuthState.role = 'admin';

  // Seed two managers + the client profile.
  dbState.profiles.push(
    { id: 'manager-X', role: 'admin', full_name: 'Anya', email: 'anya@polza.com' },
    { id: 'manager-Y', role: 'technician', full_name: 'Boris', email: 'boris@polza.com' },
    { id: 'client-A', role: 'client', full_name: 'Cleo', email: 'cleo@example.com' },
    { id: 'client-B', role: 'client', full_name: 'Dora', email: 'dora@example.com' },
  );
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('client support API — auth boundary', () => {
  it('GET /api/client/support/thread → 401 without auth', async () => {
    clientAuthState.authed = false;
    const { GET } = await import('@/app/api/client/support/thread/route');
    const res = await GET(makeReq('http://x/api/client/support/thread'));
    expect((res as Response).status).toBe(401);
  });

  it('POST /api/client/support/messages → 401 without auth', async () => {
    clientAuthState.authed = false;
    const { POST } = await import('@/app/api/client/support/messages/route');
    const res = await POST(
      makeReq('http://x/api/client/support/messages', {
        method: 'POST',
        body: { body: 'hi' },
      }),
    );
    expect((res as Response).status).toBe(401);
  });
});

describe('client support API — thread lifecycle', () => {
  it('GET creates a thread on first call and returns empty messages', async () => {
    const { GET } = await import('@/app/api/client/support/thread/route');
    const res = await GET(makeReq('http://x/api/client/support/thread'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      thread: { client_user_id: string };
      messages: unknown[];
    };
    expect(body.thread.client_user_id).toBe('client-A');
    expect(body.messages).toEqual([]);
    expect(dbState.threads).toHaveLength(1);
  });

  it('GET reuses the existing thread on subsequent calls (no duplicates)', async () => {
    const { GET } = await import('@/app/api/client/support/thread/route');
    await GET(makeReq('http://x/api/client/support/thread'));
    await GET(makeReq('http://x/api/client/support/thread'));
    expect(dbState.threads).toHaveLength(1);
  });

  it('POST validates body — empty rejected with 400', async () => {
    const { POST } = await import('@/app/api/client/support/messages/route');
    const res = await POST(
      makeReq('http://x/api/client/support/messages', {
        method: 'POST',
        body: { body: '   ' },
      }),
    );
    expect((res as Response).status).toBe(400);
    expect(dbState.messages).toHaveLength(0);
  });

  it('POST validates body — non-string rejected with 400', async () => {
    const { POST } = await import('@/app/api/client/support/messages/route');
    const res = await POST(
      makeReq('http://x/api/client/support/messages', {
        method: 'POST',
        body: { body: 123 },
      }),
    );
    expect((res as Response).status).toBe(400);
  });

  it('POST stores the message + fans out to every manager (excluding the client)', async () => {
    const { POST } = await import('@/app/api/client/support/messages/route');
    const res = await POST(
      makeReq('http://x/api/client/support/messages', {
        method: 'POST',
        body: { body: 'Hello manager' },
      }),
    );
    expect((res as Response).status).toBe(200);
    expect(dbState.messages).toHaveLength(1);
    expect(dbState.messages[0].sender_role).toBe('client');
    expect(dbState.messages[0].sender_user_id).toBe('client-A');

    // Two managers seeded → two notification rows. Client themselves not pinged.
    const managerNotifs = dbState.notifications.filter(
      (n) => n.type === 'support_message',
    );
    expect(managerNotifs).toHaveLength(2);
    const recipients = managerNotifs.map((n) => n.user_id).sort();
    expect(recipients).toEqual(['manager-X', 'manager-Y']);
    for (const n of managerNotifs) {
      expect(n.entity_type).toBe('support_thread');
      expect(typeof n.entity_id).toBe('string');
    }
  });
});

describe('admin support API — auth + RBAC', () => {
  it('GET /api/admin/support/threads → 401 without auth', async () => {
    managerAuthState.authed = false;
    const { GET } = await import('@/app/api/admin/support/threads/route');
    const res = await GET(makeReq('http://x/api/admin/support/threads'));
    expect((res as Response).status).toBe(401);
  });

  it('GET /api/admin/support/threads → 403 for a client role', async () => {
    managerAuthState.role = 'client';
    const { GET } = await import('@/app/api/admin/support/threads/route');
    const res = await GET(makeReq('http://x/api/admin/support/threads'));
    expect((res as Response).status).toBe(403);
  });

  it('GET /api/admin/support/threads → 200 for admin (lists threads with profiles)', async () => {
    // Seed a thread + last-message bits.
    dbState.threads.push({
      id: 'thread-1',
      client_user_id: 'client-A',
      last_message_at: '2026-05-09T10:00:00Z',
      last_message_role: 'client',
      last_message_preview: 'Hi',
      status: 'open',
      created_at: '2026-05-09T09:00:00Z',
      updated_at: '2026-05-09T10:00:00Z',
    });

    const { GET } = await import('@/app/api/admin/support/threads/route');
    const res = await GET(makeReq('http://x/api/admin/support/threads'));
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      threads: Array<{
        client_full_name: string | null;
        client_email: string | null;
        unread_count: number;
      }>;
      total_unread: number;
    };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].client_full_name).toBe('Cleo');
    expect(body.threads[0].client_email).toBe('cleo@example.com');
    expect(body.threads[0].unread_count).toBe(0);
    expect(body.total_unread).toBe(0);
  });

  it('GET /api/admin/support/threads aggregates unread_count from notifications for THIS manager only', async () => {
    dbState.threads.push({
      id: 'thread-1',
      client_user_id: 'client-A',
      last_message_at: '2026-05-09T10:00:00Z',
      last_message_role: 'client',
      last_message_preview: 'Hi',
      status: 'open',
      created_at: '2026-05-09T09:00:00Z',
      updated_at: '2026-05-09T10:00:00Z',
    });
    // Two unread support_message rows for manager-X pointing at thread-1,
    // and one unread row for the OTHER manager — must not leak into X's count.
    dbState.notifications.push(
      {
        id: 'n1',
        user_id: 'manager-X',
        type: 'support_message',
        entity_type: 'support_thread',
        entity_id: 'thread-1',
        is_read: false,
      },
      {
        id: 'n2',
        user_id: 'manager-X',
        type: 'support_message',
        entity_type: 'support_thread',
        entity_id: 'thread-1',
        is_read: false,
      },
      {
        id: 'n3',
        user_id: 'manager-Y',
        type: 'support_message',
        entity_type: 'support_thread',
        entity_id: 'thread-1',
        is_read: false,
      },
    );

    const { GET } = await import('@/app/api/admin/support/threads/route');
    const res = await GET(makeReq('http://x/api/admin/support/threads'));
    const body = (await (res as Response).json()) as {
      threads: Array<{ unread_count: number }>;
      total_unread: number;
    };
    expect(body.threads[0].unread_count).toBe(2);
    expect(body.total_unread).toBe(2);
  });
});

describe('admin support API — message endpoints', () => {
  beforeEach(() => {
    dbState.threads.push({
      id: 'thread-1',
      client_user_id: 'client-A',
      last_message_at: null,
      last_message_role: null,
      last_message_preview: null,
      status: 'open',
      created_at: '2026-05-09T09:00:00Z',
      updated_at: '2026-05-09T09:00:00Z',
    });
  });

  it('GET /api/admin/support/threads/[id]/messages → 404 for unknown thread', async () => {
    const { GET } = await import('@/app/api/admin/support/threads/[id]/messages/route');
    const res = await GET(
      makeReq('http://x/api/admin/support/threads/missing/messages'),
      { params: Promise.resolve({ id: 'missing' }) },
    );
    expect((res as Response).status).toBe(404);
  });

  it('POST manager reply → 200 + 1 notification for client (NOT for other managers)', async () => {
    const { POST } = await import('@/app/api/admin/support/threads/[id]/messages/route');
    const res = await POST(
      makeReq('http://x/api/admin/support/threads/thread-1/messages', {
        method: 'POST',
        body: { body: 'On it' },
      }),
      { params: Promise.resolve({ id: 'thread-1' }) },
    );
    expect((res as Response).status).toBe(200);

    expect(dbState.messages).toHaveLength(1);
    expect(dbState.messages[0].sender_role).toBe('manager');
    expect(dbState.messages[0].sender_user_id).toBe('manager-X');

    const supportNotifs = dbState.notifications.filter(
      (n) => n.type === 'support_message',
    );
    expect(supportNotifs).toHaveLength(1);
    expect(supportNotifs[0].user_id).toBe('client-A');
    expect(supportNotifs[0].entity_type).toBe('support_thread');
    expect(supportNotifs[0].entity_id).toBe('thread-1');
  });

  it('POST manager reply with empty body → 400', async () => {
    const { POST } = await import('@/app/api/admin/support/threads/[id]/messages/route');
    const res = await POST(
      makeReq('http://x/api/admin/support/threads/thread-1/messages', {
        method: 'POST',
        body: { body: '' },
      }),
      { params: Promise.resolve({ id: 'thread-1' }) },
    );
    expect((res as Response).status).toBe(400);
    expect(dbState.messages).toHaveLength(0);
  });

  it('PATCH /[id]/read marks support_message notifications for the manager as read', async () => {
    dbState.notifications.push({
      id: 'n1',
      user_id: 'manager-X',
      type: 'support_message',
      entity_type: 'support_thread',
      entity_id: 'thread-1',
      is_read: false,
    });

    const { PATCH } = await import('@/app/api/admin/support/threads/[id]/read/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/support/threads/thread-1/read', { method: 'PATCH' }),
      { params: Promise.resolve({ id: 'thread-1' }) },
    );
    expect((res as Response).status).toBe(200);
    expect(dbState.notifications[0].is_read).toBe(true);
  });
});

describe('client support GET marks unread notifications as read', () => {
  it('opening the thread clears unread notifications for the calling client', async () => {
    // Pre-seed: thread + an unread notification pointing at it.
    dbState.threads.push({
      id: 'thread-1',
      client_user_id: 'client-A',
      last_message_at: null,
      last_message_role: null,
      last_message_preview: null,
      status: 'open',
      created_at: '2026-05-09T09:00:00Z',
      updated_at: '2026-05-09T09:00:00Z',
    });
    dbState.notifications.push({
      id: 'n1',
      user_id: 'client-A',
      type: 'support_message',
      entity_type: 'support_thread',
      entity_id: 'thread-1',
      is_read: false,
    });

    const { GET } = await import('@/app/api/client/support/thread/route');
    const res = await GET(makeReq('http://x/api/client/support/thread'));
    expect((res as Response).status).toBe(200);
    expect(dbState.notifications[0].is_read).toBe(true);
  });
});
