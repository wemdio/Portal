/** @jest-environment node */

/**
 * Tests for /api/client/projects and /api/client/projects/[id].
 *
 * Endpoints expose the client's CRM projects (table `projects`) and their
 * tasks (table `tasks`) via a thin, read-only API. Authentication uses the
 * existing requireClientAuth helper. Project isolation: only rows where
 * `projects.client_user_id = auth.user.id` must be returned.
 *
 * Surface (must match implementation):
 *
 *   GET /api/client/projects
 *     200 -> {
 *       items: Array<{
 *         id: string;
 *         name: string;
 *         status: string;
 *         specialist: string | null;
 *         manager: string | null;
 *         contacts_done: string | null;
 *         contacts_obligation: string | null;
 *         deadline: string | null;
 *         launch_date: string | null;
 *         tasks_total: number;
 *         tasks_active: number;
 *         tasks_done: number;
 *         leads_count: number;
 *       }>,
 *       total: number,
 *     }
 *
 *   GET /api/client/projects/[id]
 *     200 -> {
 *       project: { id, name, description, status, specialist, manager,
 *         contacts_done, contacts_obligation, launch_date, deadline,
 *         leads_count },
 *       tasks: {
 *         active: Array<{ id, title, status, deadline }>,
 *         done:   Array<{ id, title, status, deadline }>,
 *       }
 *     }
 *     404 -> when project belongs to another user (or does not exist)
 *
 * Tasks must be exposed only as { id, title, status, deadline } – never
 * description / result / image_url, to keep internal kitchen private.
 */

const AUTH_USER_ID = 'user-A';
const OTHER_USER_ID = 'user-B';

type EqCall = { table: string; column: string; value: unknown };
type InCall = { table: string; column: string; values: unknown[] };

interface ChainState {
  table: string;
  eqCalls: EqCall[];
  inCalls: InCall[];
  selectedColumns: string | null;
  countMode: 'exact' | null;
}

const state = {
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  allEqCalls: [] as EqCall[],
  allInCalls: [] as InCall[],
  selectsByTable: {} as Record<string, string[]>,
};

function resetState() {
  state.rowsByTable = {};
  state.allEqCalls = [];
  state.allInCalls = [];
  state.selectsByTable = {};
}

function makeBuilder(table: string) {
  const local: ChainState = {
    table,
    eqCalls: [],
    inCalls: [],
    selectedColumns: null,
    countMode: null,
  };

  const finalize = () => {
    let rows = state.rowsByTable[table] ?? [];
    for (const eq of local.eqCalls) {
      rows = rows.filter((r) => r[eq.column] === eq.value);
    }
    for (const inFilter of local.inCalls) {
      rows = rows.filter((r) => inFilter.values.includes(r[inFilter.column]));
    }
    return { data: rows, error: null, count: rows.length };
  };

  const builder: Record<string, unknown> = {
    select: (columns?: string, opts?: { count?: 'exact' }) => {
      local.selectedColumns = columns ?? null;
      if (columns) {
        if (!state.selectsByTable[table]) state.selectsByTable[table] = [];
        state.selectsByTable[table].push(columns);
      }
      if (opts?.count === 'exact') local.countMode = 'exact';
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    range: async () => finalize(),
    eq: (column: string, value: unknown) => {
      local.eqCalls.push({ table, column, value });
      state.allEqCalls.push({ table, column, value });
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      local.inCalls.push({ table, column, values });
      state.allInCalls.push({ table, column, values });
      return builder;
    },
    single: async () => {
      const result = finalize();
      const first = result.data[0] ?? null;
      return { data: first, error: first ? null : { message: 'not found' } };
    },
    maybeSingle: async () => {
      const result = finalize();
      return { data: result.data[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      resolve(finalize());
    },
  };

  return builder;
}

const adminFromMock = jest.fn((table: string) => makeBuilder(table));
const instantlyFromMock = jest.fn((table: string) => makeBuilder(table));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => adminFromMock(table) },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: { from: (table: string) => instantlyFromMock(table) },
}));

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: { userId: AUTH_USER_ID, accessRows: [] },
    })),
  };
});

import { NextRequest } from 'next/server';

function makeReq(url: string): NextRequest {
  const req = new Request(url, {
    headers: { authorization: 'Bearer test-token' },
  });
  return req as unknown as NextRequest;
}

function ownsClientScope(table: string, column = 'client_user_id'): boolean {
  return state.allEqCalls.some(
    (c) => c.table === table && c.column === column && c.value === AUTH_USER_ID,
  );
}

beforeEach(() => {
  resetState();
  adminFromMock.mockClear();
  instantlyFromMock.mockClear();
});

describe('GET /api/client/projects — list', () => {
  it('only returns projects scoped to the authenticated client', async () => {
    state.rowsByTable.projects = [
      {
        id: 'p1',
        client_user_id: AUTH_USER_ID,
        name: 'Mine',
        status: 'В работе',
        specialist: 'Alice',
        manager: 'Bob',
        contacts_done: '120',
        contacts_obligation: '500',
        deadline: '2026-05-01',
        launch_date: '2026-01-15',
      },
      {
        id: 'p2',
        client_user_id: OTHER_USER_ID,
        name: 'NotMine',
        status: 'В работе',
      },
    ];
    state.rowsByTable.tasks = [];
    state.rowsByTable.client_forwarded_leads = [];

    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    const body = (await (res as Response).json()) as {
      items: Array<{ id: string; name: string }>;
      total: number;
    };

    expect((res as Response).status).toBe(200);
    expect(ownsClientScope('projects')).toBe(true);
    expect(body.items.map((p) => p.id)).toEqual(['p1']);
    expect(body.items[0].name).toBe('Mine');
    expect(body.total).toBe(1);
  });

  it('aggregates task counters per project (active vs done)', async () => {
    state.rowsByTable.projects = [
      { id: 'p1', client_user_id: AUTH_USER_ID, name: 'P1', status: 'В работе' },
    ];
    state.rowsByTable.tasks = [
      { id: 't1', project_id: 'p1', status: 'pending', title: 'a' },
      { id: 't2', project_id: 'p1', status: 'in_progress', title: 'b' },
      { id: 't3', project_id: 'p1', status: 'done', title: 'c' },
      { id: 't4', project_id: 'p1', status: 'done', title: 'd' },
      { id: 't5', project_id: 'other', status: 'done', title: 'leak' },
    ];
    state.rowsByTable.client_forwarded_leads = [];

    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    const body = (await (res as Response).json()) as {
      items: Array<{
        id: string;
        tasks_total: number;
        tasks_active: number;
        tasks_done: number;
      }>;
    };

    const item = body.items.find((p) => p.id === 'p1');
    expect(item).toBeDefined();
    expect(item!.tasks_total).toBe(4);
    expect(item!.tasks_active).toBe(2);
    expect(item!.tasks_done).toBe(2);
  });

  it('exposes contacts_done / contacts_obligation / specialist / manager / dates', async () => {
    state.rowsByTable.projects = [
      {
        id: 'p1',
        client_user_id: AUTH_USER_ID,
        name: 'P1',
        status: 'В работе',
        specialist: 'Alice',
        manager: 'Bob',
        contacts_done: '120',
        contacts_obligation: '500',
        deadline: '2026-05-01',
        launch_date: '2026-01-15',
      },
    ];
    state.rowsByTable.tasks = [];
    state.rowsByTable.client_forwarded_leads = [];

    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
    };

    const item = body.items[0];
    expect(item.specialist).toBe('Alice');
    expect(item.manager).toBe('Bob');
    expect(item.contacts_done).toBe('120');
    expect(item.contacts_obligation).toBe('500');
    expect(item.deadline).toBe('2026-05-01');
    expect(item.launch_date).toBe('2026-01-15');
  });

  it('includes leads_count from client_forwarded_leads scoped to the user and project', async () => {
    state.rowsByTable.projects = [
      { id: 'p1', client_user_id: AUTH_USER_ID, name: 'P1', status: 'В работе' },
    ];
    state.rowsByTable.tasks = [];
    state.rowsByTable.client_forwarded_leads = [
      { id: 'l1', client_user_id: AUTH_USER_ID, project_id: 'p1' },
      { id: 'l2', client_user_id: AUTH_USER_ID, project_id: 'p1' },
      { id: 'l3', client_user_id: AUTH_USER_ID, project_id: 'other' },
      { id: 'l4', client_user_id: OTHER_USER_ID, project_id: 'p1' },
    ];

    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    const body = (await (res as Response).json()) as {
      items: Array<{ id: string; leads_count: number }>;
    };

    expect(ownsClientScope('client_forwarded_leads')).toBe(true);
    const item = body.items.find((p) => p.id === 'p1');
    expect(item!.leads_count).toBe(2);
  });

  it('returns empty list when client has no projects', async () => {
    state.rowsByTable.projects = [
      { id: 'p2', client_user_id: OTHER_USER_ID, name: 'NotMine', status: 'В работе' },
    ];
    state.rowsByTable.tasks = [];
    state.rowsByTable.client_forwarded_leads = [];

    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    const body = (await (res as Response).json()) as {
      items: unknown[];
      total: number;
    };

    expect((res as Response).status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns 401 when requireClientAuth fails', async () => {
    const { requireClientAuth } = jest.requireMock('@/lib/clientApiHelper') as {
      requireClientAuth: jest.Mock;
    };
    const { NextResponse } = jest.requireActual('next/server');
    requireClientAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const { GET } = await import('@/app/api/client/projects/route');
    const res = await GET(makeReq('http://x/api/client/projects'));
    expect((res as Response).status).toBe(401);
  });
});

describe('GET /api/client/projects/[id] — detail', () => {
  function seedProjects() {
    state.rowsByTable.projects = [
      {
        id: 'p1',
        client_user_id: AUTH_USER_ID,
        name: 'Mine',
        description: 'desc',
        status: 'В работе',
        specialist: 'Alice',
        manager: 'Bob',
        contacts_done: '120',
        contacts_obligation: '500',
        deadline: '2026-05-01',
        launch_date: '2026-01-15',
      },
      {
        id: 'p2',
        client_user_id: OTHER_USER_ID,
        name: 'NotMine',
        status: 'В работе',
      },
    ];
    state.rowsByTable.tasks = [];
    state.rowsByTable.client_forwarded_leads = [];
  }

  it('returns 404 when project belongs to another user', async () => {
    seedProjects();
    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/p2'), {
      params: Promise.resolve({ id: 'p2' }),
    });
    expect((res as Response).status).toBe(404);
  });

  it('returns 404 when project does not exist', async () => {
    seedProjects();
    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/none'), {
      params: Promise.resolve({ id: 'none' }),
    });
    expect((res as Response).status).toBe(404);
  });

  it('returns project with tasks split into active/done buckets', async () => {
    seedProjects();
    state.rowsByTable.tasks = [
      {
        id: 't1',
        project_id: 'p1',
        title: 'do A',
        status: 'pending',
        deadline: '2026-04-25',
        description: 'internal',
        result: 'internal-result',
      },
      {
        id: 't2',
        project_id: 'p1',
        title: 'do B',
        status: 'in_progress',
        deadline: null,
        description: 'internal',
      },
      {
        id: 't3',
        project_id: 'p1',
        title: 'done C',
        status: 'done',
        deadline: '2026-03-01',
      },
      {
        id: 't4',
        project_id: 'other',
        title: 'leak',
        status: 'pending',
      },
    ];

    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    });
    const body = (await (res as Response).json()) as {
      project: Record<string, unknown>;
      tasks: {
        active: Array<Record<string, unknown>>;
        done: Array<Record<string, unknown>>;
      };
    };

    expect((res as Response).status).toBe(200);
    expect(body.project.id).toBe('p1');
    expect(body.project.name).toBe('Mine');
    expect(body.project.specialist).toBe('Alice');
    expect(body.project.manager).toBe('Bob');
    expect(body.project.contacts_done).toBe('120');
    expect(body.project.contacts_obligation).toBe('500');

    expect(body.tasks.active.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(body.tasks.done.map((t) => t.id)).toEqual(['t3']);
    expect(body.tasks.active.find((t) => t.id === 't4')).toBeUndefined();
  });

  it('exposes only safe task fields (no description / result / image_url)', async () => {
    seedProjects();
    state.rowsByTable.tasks = [
      {
        id: 't1',
        project_id: 'p1',
        title: 'public title',
        status: 'pending',
        deadline: '2026-04-25',
        description: 'INTERNAL DESCRIPTION',
        result: 'INTERNAL RESULT',
        image_url: 'https://internal/image.png',
        created_by: 'manager@internal',
      },
    ];

    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    });
    const body = (await (res as Response).json()) as {
      tasks: { active: Array<Record<string, unknown>> };
    };

    const task = body.tasks.active[0];
    expect(task).toBeDefined();
    expect(Object.keys(task).sort()).toEqual(['deadline', 'id', 'status', 'title']);
    expect(task.title).toBe('public title');
    expect(task.deadline).toBe('2026-04-25');
    expect(task.description).toBeUndefined();
    expect(task.result).toBeUndefined();
    expect(task.image_url).toBeUndefined();
    expect(task.created_by).toBeUndefined();
  });

  it('includes leads_count for the project scoped to user', async () => {
    seedProjects();
    state.rowsByTable.client_forwarded_leads = [
      { id: 'l1', client_user_id: AUTH_USER_ID, project_id: 'p1' },
      { id: 'l2', client_user_id: AUTH_USER_ID, project_id: 'p1' },
      { id: 'l3', client_user_id: AUTH_USER_ID, project_id: 'p1' },
      { id: 'l4', client_user_id: AUTH_USER_ID, project_id: 'other' },
      { id: 'l5', client_user_id: OTHER_USER_ID, project_id: 'p1' },
    ];

    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    });
    const body = (await (res as Response).json()) as {
      project: { leads_count: number };
    };

    expect(body.project.leads_count).toBe(3);
    expect(ownsClientScope('client_forwarded_leads')).toBe(true);
  });

  it('returns 401 when requireClientAuth fails', async () => {
    const { requireClientAuth } = jest.requireMock('@/lib/clientApiHelper') as {
      requireClientAuth: jest.Mock;
    };
    const { NextResponse } = jest.requireActual('next/server');
    requireClientAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const { GET } = await import('@/app/api/client/projects/[id]/route');
    const res = await GET(makeReq('http://x/api/client/projects/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    });
    expect((res as Response).status).toBe(401);
  });
});
