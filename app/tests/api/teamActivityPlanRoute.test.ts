/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const HR_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const LEAD_ID = '00000000-0000-4000-8000-000000000001';
const SERGEY_ID = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-000000000002';
const STAFF_ID = '00000000-0000-4000-8000-000000000003';
const CLIENT_ID = '00000000-0000-4000-8000-000000000004';
const DEMO_HR_ID = '00000000-0000-4000-8000-000000000005';
const DEMO_ADMIN_ID = '00000000-0000-4000-8000-000000000006';
const ITEM_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_MONTH_ITEM_ID = '00000000-0000-4000-8000-000000000011';
const ITEM_UPDATED_AT = '2026-08-06T09:00:00.000Z';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockCurrentUser: { id: string } | null = { id: HR_ID };
const ACTIVITY_PLAN_VIEWERS = new Set([HR_ID, SERGEY_ID]);
const ACTIVITY_PLAN_MANAGERS = new Set([HR_ID, SERGEY_ID]);
const mockGetUser = jest.fn(async () => ({ data: { user: mockCurrentUser } }));
const mockActivityPlanCapability = jest.fn(
  async (_functionName: string): Promise<{
    data: boolean | null;
    error: { message: string } | null;
  }> => ({
    data: currentUserHasActivityPlanCapability(_functionName),
    error: null,
  }),
);
const mockLogAudit = jest.fn(async (..._args: unknown[]) => {});
const mockLogError = jest.fn(async (..._args: unknown[]) => {});

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => header?.replace(/^Bearer\s+/i, '') || null,
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: () => mockGetUser(),
    },
    rpc: (functionName: string) => mockActivityPlanCapability(functionName),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

function profile(
  id: string,
  role: string,
  options: { isHr?: boolean; isDemo?: boolean } = {},
) {
  return {
    id,
    role,
    full_name: `Profile ${id}`,
    email: `${id}@example.com`,
    is_hr: options.isHr ?? false,
    is_demo: options.isDemo ?? false,
  };
}

function currentUserHasActivityPlanCapability(functionName: string): boolean {
  if (!mockCurrentUser) return false;
  if (functionName === 'can_view_team_activity_plan') {
    return ACTIVITY_PLAN_VIEWERS.has(mockCurrentUser.id);
  }
  if (functionName === 'can_manage_team_activity_plan') {
    return ACTIVITY_PLAN_MANAGERS.has(mockCurrentUser.id);
  }
  return false;
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    plan_month: '2026-08-01',
    periodicity: 'Еженедельно',
    activity: 'Обучающий созвон по средам',
    format: 'Телемост',
    planned_date: '2026-08-07',
    planned_time: '14:00:00',
    schedule_note: null,
    note: 'Свободный формат',
    budget_amount: 700,
    budget_note: 'Приз победителю',
    status: 'planned',
    position: 10,
    created_by: HR_ID,
    created_at: '2026-08-01T08:00:00.000Z',
    updated_at: ITEM_UPDATED_AT,
    ...overrides,
  };
}

function seedDatabase() {
  mockMainDb = createMockSupabase({
    tables: {
      profiles: [
        // Preserve explicit is_hr access for a non-admin internal employee.
        profile(HR_ID, 'technician', { isHr: true }),
        profile(LEAD_ID, 'lead'),
        profile(SERGEY_ID, 'admin'),
        profile(OTHER_ADMIN_ID, 'admin'),
        profile(STAFF_ID, 'manager'),
        profile(CLIENT_ID, 'client'),
        profile(DEMO_HR_ID, 'technician', { isHr: true, isDemo: true }),
        profile(DEMO_ADMIN_ID, 'admin', { isDemo: true }),
      ],
      team_activity_plan_items: [
        activityRow(),
        activityRow({
          id: OTHER_MONTH_ITEM_ID,
          plan_month: '2026-09-01',
          activity: 'Сентябрьская активность',
          planned_date: '2026-09-10',
          budget_amount: null,
        }),
      ],
    },
  });
}

function request(
  path: string,
  init: { method?: Method; body?: unknown; authenticated?: boolean } = {},
) {
  const headers = new Headers();
  if (init.authenticated !== false) headers.set('authorization', 'Bearer test-token');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`http://portal.local${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function validCreateBody() {
  return {
    planMonth: '2026-08',
    periodicity: '  По календарю  ',
    activity: '  Поздравление с днём рождения  ',
    format: '  Пост в общем чате  ',
    // An activity may intentionally be prepared in one month's plan for another date.
    plannedDate: '2026-09-04',
    plannedTime: '09:30',
    scheduleNote: null,
    note: '  Заранее заказать подарок  ',
    budgetAmount: 2000,
    budgetNote: '  Подарок  ',
    position: 30,
  };
}

async function invoke(
  method: Method,
  options: { authenticated?: boolean; body?: unknown } = {},
) {
  if (method === 'GET') {
    const { GET } = await import('@/app/api/team/activity-plan/route');
    return GET(request('/api/team/activity-plan?month=2026-08', {
      authenticated: options.authenticated,
    }));
  }

  if (method === 'POST') {
    const { POST } = await import('@/app/api/team/activity-plan/route');
    return POST(request('/api/team/activity-plan', {
      method,
      authenticated: options.authenticated,
      body: options.body ?? validCreateBody(),
    }));
  }

  const route = await import('@/app/api/team/activity-plan/[id]/route');
  const body = options.body ?? (
    method === 'PATCH'
      ? { expectedUpdatedAt: ITEM_UPDATED_AT, activity: 'Обновлённая активность' }
      : { expectedUpdatedAt: ITEM_UPDATED_AT }
  );
  const req = request(`/api/team/activity-plan/${ITEM_ID}`, {
    method,
    authenticated: options.authenticated,
    body,
  });
  const context = { params: Promise.resolve({ id: ITEM_ID }) };
  return method === 'PATCH'
    ? route.PATCH(req, context)
    : route.DELETE(req, context);
}

function planSelects() {
  return mockMainDb.selects.filter((call) => call.table === 'team_activity_plan_items');
}

function successAuditEvents() {
  return mockLogAudit.mock.calls
    .map(([event]) => event)
    .filter((event) => typeof event === 'string' && event.endsWith('.success'));
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  // Still August 7 in UTC, but already August 8 in Europe/Moscow.
  jest.setSystemTime(new Date('2026-08-07T22:30:00.000Z'));
  mockCurrentUser = { id: HR_ID };
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(async () => ({ data: { user: mockCurrentUser } }));
  mockActivityPlanCapability.mockReset();
  mockActivityPlanCapability.mockImplementation(async (functionName: string) => ({
    data: currentUserHasActivityPlanCapability(functionName),
    error: null,
  }));
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  seedDatabase();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('team activity plan authorization', () => {
  it.each<Method>(['GET', 'POST', 'PATCH', 'DELETE'])(
    'rejects anonymous %s before any admin database query',
    async (method) => {
      const response = await invoke(method, { authenticated: false });

      expect(response.status).toBe(401);
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockActivityPlanCapability).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it('rejects an invalid bearer session before any admin database query', async () => {
    mockCurrentUser = null;

    const response = await invoke('GET');

    expect(response.status).toBe(401);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(mockActivityPlanCapability).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it('returns 500 and logs a thrown auth infrastructure error before any database query', async () => {
    const authError = new Error('auth service unavailable');
    mockGetUser.mockRejectedValueOnce(authError);

    const response = await invoke('GET');

    expect(response.status).toBe(500);
    expect(mockActivityPlanCapability).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'team.activity_plan.auth.failed',
      authError,
      {},
      expect.objectContaining({
        userId: null,
        route: '/api/team/activity-plan',
      }),
    );
  });

  it('returns 500 and logs a capability RPC failure before any service-role query', async () => {
    const rpcError = { message: 'authorization predicate unavailable' };
    mockActivityPlanCapability.mockResolvedValueOnce({ data: null, error: rpcError });

    const response = await invoke('GET');

    expect(response.status).toBe(500);
    expect(mockActivityPlanCapability)
      .toHaveBeenCalledWith('can_view_team_activity_plan');
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'team.activity_plan.auth.failed',
      rpcError,
      {},
      expect.objectContaining({ userId: HR_ID }),
    );
  });

  it.each([
    ['leadership', LEAD_ID],
    ['ordinary staff', STAFF_ID],
    ['client', CLIENT_ID],
  ])('does not substitute the %s role for the is_hr capability', async (_label, userId) => {
    mockCurrentUser = { id: userId };

    const response = await invoke('GET');

    expect(response.status).toBe(403);
    expect(mockActivityPlanCapability)
      .toHaveBeenCalledWith('can_view_team_activity_plan');
    expect(mockMainDb.selects).toHaveLength(0);
    expect(planSelects()).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it('gives Sergey full management access to the plan', async () => {
    mockCurrentUser = { id: SERGEY_ID };

    const response = await invoke('GET');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.canManage).toBe(true);
    expect(mockActivityPlanCapability.mock.calls).toEqual([
      ['can_view_team_activity_plan'],
      ['can_manage_team_activity_plan'],
    ]);
  });

  it.each<Method>(['POST', 'PATCH', 'DELETE'])(
    'allows Sergey to write through %s',
    async (method) => {
      mockCurrentUser = { id: SERGEY_ID };

      const response = await invoke(method);

      expect(response.status).toBe(method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200);
      expect(mockActivityPlanCapability.mock.calls).toEqual([
        ['can_manage_team_activity_plan'],
      ]);
    },
  );

  it.each<Method>(['GET', 'POST', 'PATCH', 'DELETE'])(
    'denies another non-demo admin through %s before service-role access',
    async (method) => {
      mockCurrentUser = { id: OTHER_ADMIN_ID };

      const response = await invoke(method);

      expect(response.status).toBe(403);
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it.each<[Method, number]>([
    ['GET', 200],
    ['POST', 201],
    ['PATCH', 200],
    ['DELETE', 204],
  ])('preserves explicit HR management through %s', async (method, expectedStatus) => {
    mockCurrentUser = { id: HR_ID };

    const response = await invoke(method);

    expect(response.status).toBe(expectedStatus);
  });

  it.each<[Method, string]>([
    ['GET', 'can_view_team_activity_plan'],
    ['POST', 'can_manage_team_activity_plan'],
    ['PATCH', 'can_manage_team_activity_plan'],
    ['DELETE', 'can_manage_team_activity_plan'],
  ])(
    'denies a non-admin without is_hr on %s after only the caller-JWT capability RPC',
    async (method, expectedCapability) => {
      mockCurrentUser = { id: STAFF_ID };

      const response = await invoke(method);

      expect(response.status).toBe(403);
      expect(mockActivityPlanCapability)
        .toHaveBeenCalledWith(expectedCapability);
      expect(mockMainDb.selects).toHaveLength(0);
      expect(planSelects()).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it.each([
    ['explicit HR', DEMO_HR_ID],
    ['admin', DEMO_ADMIN_ID],
  ])('rejects a demo %s', async (_label, userId) => {
    mockCurrentUser = { id: userId };

    const response = await invoke('GET');

    expect(response.status).toBe(403);
    expect(mockActivityPlanCapability)
      .toHaveBeenCalledWith('can_view_team_activity_plan');
    expect(mockMainDb.selects).toHaveLength(0);
    expect(planSelects()).toHaveLength(0);
  });
});

describe('GET /api/team/activity-plan', () => {
  it('returns only the requested month in the canonical camelCase shape', async () => {
    const response = await invoke('GET');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      asOf: '2026-08-08',
      period: {
        month: '2026-08',
        label: 'Август 2026',
        previousMonth: '2026-07',
        nextMonth: '2026-09',
      },
      items: [
        {
          id: ITEM_ID,
          planMonth: '2026-08',
          periodicity: 'Еженедельно',
          activity: 'Обучающий созвон по средам',
          format: 'Телемост',
          plannedDate: '2026-08-07',
          plannedTime: '14:00',
          scheduleNote: null,
          note: 'Свободный формат',
          budgetAmount: 700,
          budgetNote: 'Приз победителю',
          status: 'planned',
          position: 10,
          createdAt: '2026-08-01T08:00:00.000Z',
          updatedAt: ITEM_UPDATED_AT,
        },
      ],
      summary: {
        total: 1,
        planned: 1,
        completed: 0,
        cancelled: 0,
        overdue: 1,
        budgetAmount: 700,
        budgetUnspecified: 0,
      },
      canManage: true,
    });
  });

  it.each(['0000-01', '0001-01', '2026-8', '2026-13', 'not-a-month'])(
    'rejects invalid month %s before reading plan items',
    async (month) => {
      const { GET } = await import('@/app/api/team/activity-plan/route');
      const response = await GET(request(`/api/team/activity-plan?month=${month}`));

      expect(response.status).toBe(400);
      expect(planSelects()).toHaveLength(0);
    },
  );
});

describe('POST /api/team/activity-plan', () => {
  it('creates a normalized item and permits a planned date outside planMonth', async () => {
    const response = await invoke('POST');
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockMainDb.inserts).toContainEqual({
      table: 'team_activity_plan_items',
      rows: [
        expect.objectContaining({
          plan_month: '2026-08-01',
          periodicity: 'По календарю',
          activity: 'Поздравление с днём рождения',
          format: 'Пост в общем чате',
          planned_date: '2026-09-04',
          planned_time: '09:30',
          schedule_note: null,
          note: 'Заранее заказать подарок',
          budget_amount: 2000,
          budget_note: 'Подарок',
          status: 'planned',
          position: 30,
          created_by: HR_ID,
        }),
      ],
    });
    expect(body.item).toEqual(expect.objectContaining({
      planMonth: '2026-08',
      periodicity: 'По календарю',
      activity: 'Поздравление с днём рождения',
      plannedDate: '2026-09-04',
      plannedTime: '09:30',
      status: 'planned',
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.activity_plan.create.success',
      'Team activity plan item created',
      expect.objectContaining({
        itemId: expect.any(String),
        planMonth: '2026-08',
      }),
      expect.objectContaining({ userId: HR_ID }),
    );
  });

  it('accepts text-only scheduling and an explicitly unspecified budget', async () => {
    const response = await invoke('POST', {
      body: {
        planMonth: '2026-08',
        periodicity: 'Еженедельно',
        activity: 'Публикация полезной информации',
        scheduleNote: 'Каждую среду',
        plannedDate: null,
        plannedTime: null,
        budgetAmount: null,
        budgetNote: 'Размер премии определят позже',
      },
    });

    expect(response.status).toBe(201);
    expect(mockMainDb.inserts.at(-1)?.rows[0]).toEqual(expect.objectContaining({
      planned_date: null,
      planned_time: null,
      schedule_note: 'Каждую среду',
      budget_amount: null,
      budget_note: 'Размер премии определят позже',
    }));
  });

  it('rejects plannedTime without an exact plannedDate', async () => {
    const response = await invoke('POST', {
      body: {
        ...validCreateBody(),
        plannedDate: null,
        plannedTime: '09:30',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('plannedTime');
    expect(mockMainDb.inserts).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('rejects an exact plannedDate together with scheduleNote', async () => {
    const response = await invoke('POST', {
      body: {
        ...validCreateBody(),
        scheduleNote: 'Каждую среду',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('plannedDate');
    expect(body.error).toContain('scheduleNote');
    expect(mockMainDb.inserts).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it.each([
    ['planMonth', { planMonth: '0000-01' }],
    ['planMonth', { planMonth: '0001-01' }],
    ['planMonth', { planMonth: '2026-8' }],
    ['planMonth', { planMonth: '2026-13' }],
    ['periodicity', { periodicity: '   ' }],
    ['periodicity', { periodicity: 'x'.repeat(101) }],
    ['activity', { activity: '   ' }],
    ['activity', { activity: 'x'.repeat(501) }],
    ['format', { format: 'x'.repeat(501) }],
    ['plannedDate', { plannedDate: '2026-02-30' }],
    ['plannedTime', { plannedTime: '24:00' }],
    ['plannedTime', { plannedTime: '9:30' }],
    ['scheduleNote', { scheduleNote: 'x'.repeat(501) }],
    ['note', { note: 'x'.repeat(5001) }],
    ['budgetAmount', { budgetAmount: -1 }],
    ['budgetAmount', { budgetAmount: '700' }],
    ['budgetNote', { budgetNote: 'x'.repeat(501) }],
    ['status', { status: 'done' }],
    ['position', { position: -1 }],
    ['position', { position: 1.5 }],
  ])('rejects invalid %s without writing or auditing success', async (field, patch) => {
    const response = await invoke('POST', {
      body: { ...validCreateBody(), ...patch },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain(field);
    expect(mockMainDb.inserts).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });
});

describe('PATCH /api/team/activity-plan/[id]', () => {
  it('updates only accepted fields under an id plus updated_at CAS guard', async () => {
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ITEM_UPDATED_AT,
        activity: '  Обновлённый обучающий созвон  ',
        plannedDate: null,
        plannedTime: null,
        scheduleNote: '  Каждую вторую среду  ',
        budgetAmount: null,
        budgetNote: '  Без отдельного бюджета  ',
        status: 'completed',
        position: 20,
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z',
        createdBy: OTHER_ADMIN_ID,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockMainDb.updates.at(-1)).toEqual(expect.objectContaining({
      table: 'team_activity_plan_items',
      patch: expect.objectContaining({
        activity: 'Обновлённый обучающий созвон',
        planned_date: null,
        planned_time: null,
        schedule_note: 'Каждую вторую среду',
        budget_amount: null,
        budget_note: 'Без отдельного бюджета',
        status: 'completed',
        position: 20,
      }),
      filters: expect.arrayContaining([
        { column: 'id', op: 'eq', value: ITEM_ID },
        { column: 'updated_at', op: 'eq', value: ITEM_UPDATED_AT },
      ]),
    }));
    expect(mockMainDb.updates.at(-1)?.patch).not.toEqual(expect.objectContaining({
      expectedUpdatedAt: expect.anything(),
    }));
    expect(mockMainDb.updates.at(-1)?.patch).not.toHaveProperty('created_at');
    expect(mockMainDb.updates.at(-1)?.patch).not.toHaveProperty('updated_at');
    expect(mockMainDb.updates.at(-1)?.patch).not.toHaveProperty('created_by');
    expect(body.item).toEqual(expect.objectContaining({
      id: ITEM_ID,
      activity: 'Обновлённый обучающий созвон',
      scheduleNote: 'Каждую вторую среду',
      status: 'completed',
      position: 20,
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.activity_plan.update.success',
      'Team activity plan item updated',
      expect.objectContaining({ itemId: ITEM_ID }),
      expect.objectContaining({ userId: HR_ID }),
    );
  });

  it('rejects clearing plannedDate while the stored plannedTime remains', async () => {
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ITEM_UPDATED_AT,
        plannedDate: null,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('plannedTime');
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('rejects adding scheduleNote while the stored plannedDate remains', async () => {
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ITEM_UPDATED_AT,
        scheduleNote: 'Каждую среду',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('plannedDate');
    expect(body.error).toContain('scheduleNote');
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('requires expectedUpdatedAt before reading or updating the item', async () => {
    const response = await invoke('PATCH', {
      body: { activity: 'Попытка без версии' },
    });
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body).toEqual(expect.objectContaining({ code: 'precondition_required' }));
    expect(planSelects()).toHaveLength(0);
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it.each([null, 'not-a-timestamp', '2026-08-06T09:00:00', '2026-02-30T09:00:00Z'])(
    'rejects invalid expectedUpdatedAt %# before updating',
    async (expectedUpdatedAt) => {
      const response = await invoke('PATCH', {
        body: { expectedUpdatedAt, activity: 'Невалидная версия' },
      });

      expect(response.status).toBe(400);
      expect(mockMainDb.updates).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it('returns 409 for a stale item without changing data or auditing success', async () => {
    const before = mockMainDb.getRows('team_activity_plan_items');

    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: '2026-08-06T08:59:59.000Z',
        activity: 'Устаревшая правка',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      code: 'activity_plan_conflict',
      currentUpdatedAt: ITEM_UPDATED_AT,
    }));
    expect(mockMainDb.getRows('team_activity_plan_items')).toEqual(before);
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('rejects an empty patch after removing the precondition field', async () => {
    const response = await invoke('PATCH', {
      body: { expectedUpdatedAt: ITEM_UPDATED_AT },
    });

    expect(response.status).toBe(400);
    expect(mockMainDb.updates).toHaveLength(0);
  });
});

describe('DELETE /api/team/activity-plan/[id]', () => {
  it('deletes the matching version and audits only after success', async () => {
    const response = await invoke('DELETE');

    expect(response.status).toBe(204);
    expect(mockMainDb.getRows('team_activity_plan_items'))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: ITEM_ID })]));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.activity_plan.delete.success',
      'Team activity plan item deleted',
      expect.objectContaining({ itemId: ITEM_ID }),
      expect.objectContaining({ userId: HR_ID }),
    );
  });

  it('requires expectedUpdatedAt before reading or deleting the item', async () => {
    const response = await invoke('DELETE', { body: {} });

    expect(response.status).toBe(428);
    expect(planSelects()).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('returns 409 for a stale delete without deleting or auditing success', async () => {
    const before = mockMainDb.getRows('team_activity_plan_items');

    const response = await invoke('DELETE', {
      body: { expectedUpdatedAt: '2026-08-06T08:59:59.000Z' },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      code: 'activity_plan_conflict',
      currentUpdatedAt: ITEM_UPDATED_AT,
    }));
    expect(mockMainDb.getRows('team_activity_plan_items')).toEqual(before);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('returns 404 for an unknown item without a success audit', async () => {
    const { DELETE } = await import('@/app/api/team/activity-plan/[id]/route');
    const unknownId = '00000000-0000-4000-8000-000000000099';
    const response = await DELETE(
      request(`/api/team/activity-plan/${unknownId}`, {
        method: 'DELETE',
        body: { expectedUpdatedAt: ITEM_UPDATED_AT },
      }),
      { params: Promise.resolve({ id: unknownId }) },
    );

    expect(response.status).toBe(404);
    expect(successAuditEvents()).toHaveLength(0);
  });
});
