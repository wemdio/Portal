/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const ALINA_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const SERGEY_ID = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
const ANYA_ID = '9e2c53fe-4b86-40b1-b464-757ffe0944dd';
const NIKITA_ID = '416b456b-83b4-48c1-9eeb-9cb6ab88e455';
const LEAD_ID = '00000000-0000-4000-8000-000000000001';
const DIRECTOR_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-000000000004';
const STAFF_ID = '00000000-0000-4000-8000-000000000005';
const CLIENT_ID = '00000000-0000-4000-8000-000000000006';
const DEMO_LEAD_ID = '00000000-0000-4000-8000-000000000007';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000011';
const PROJECT_ID = '00000000-0000-4000-8000-000000000020';
const UNNAMED_PROJECT_ID = '00000000-0000-4000-8000-000000000021';
const EQUAL_PROJECT_ID = '00000000-0000-4000-8000-000000000022';
const CASE_EQUAL_PROJECT_ID = '00000000-0000-4000-8000-000000000023';
const REQUEST_ID = '00000000-0000-4000-8000-000000000030';
const IN_PROGRESS_ID = '00000000-0000-4000-8000-000000000031';
const CONVERTED_ID = '00000000-0000-4000-8000-000000000032';
const DECLINED_ID = '00000000-0000-4000-8000-000000000033';
const PRIVATE_REQUEST_ID = '00000000-0000-4000-8000-000000000034';
const LINKED_REVIEW_ID = '00000000-0000-4000-8000-000000000040';
const UPDATED_AT = '2026-08-11T08:00:00.000Z';

const routePath = path.resolve(
  __dirname,
  '../../src/app/api/team/review-requests/route.ts',
);
const summaryRoutePath = path.resolve(
  __dirname,
  '../../src/app/api/team/review-requests/summary/route.ts',
);
const sharedRoutePath = path.resolve(
  __dirname,
  '../../src/app/api/team/review-requests/shared/route.ts',
);
const itemRoutePath = path.resolve(
  __dirname,
  '../../src/app/api/team/review-requests/[id]/route.ts',
);

const PRIVATE_USERS = new Set([ALINA_ID, SERGEY_ID]);
const SUBMITTERS = new Set([
  ALINA_ID,
  SERGEY_ID,
  ANYA_ID,
  NIKITA_ID,
  LEAD_ID,
  DIRECTOR_ID,
]);
const SHARED_VIEWERS = new Set([LEAD_ID, DIRECTOR_ID]);

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockCurrentUser: { id: string } | null = { id: ALINA_ID };
const mockGetUser = jest.fn(async (): Promise<{
  data: { user: { id: string } | null };
  error: { message: string; status?: number } | null;
}> => ({ data: { user: mockCurrentUser }, error: null }));
const mockRpc = jest.fn(
  async (
    functionName: string,
  ): Promise<{ data: boolean | null; error: { message: string } | null }> => ({
    data: functionName === 'can_access_team'
      ? Boolean(mockCurrentUser && PRIVATE_USERS.has(mockCurrentUser.id))
      : functionName === 'can_submit_team_review_request'
        ? Boolean(mockCurrentUser && SUBMITTERS.has(mockCurrentUser.id))
        : functionName === 'can_view_team_review_requests_shared'
          ? Boolean(mockCurrentUser && SHARED_VIEWERS.has(mockCurrentUser.id))
        : false,
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
    auth: { getUser: () => mockGetUser() },
    rpc: (functionName: string) => mockRpc(functionName),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

function profile(
  id: string,
  role: string,
  name: string,
  options: { isDemo?: boolean } = {},
) {
  return {
    id,
    role,
    full_name: name,
    email: `${id}@example.com`,
    avatar_url: null,
    is_demo: options.isDemo ?? false,
  };
}

function reviewRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    employee_user_id: EMPLOYEE_ID,
    requested_by_user_id: LEAD_ID,
    project_id: PROJECT_ID,
    problem: 'Нужна помощь с приоритизацией',
    examples: 'Две задачи сорвали срок на этой неделе',
    desired_outcome: 'Зафиксировать план развития',
    visibility: 'lead_shared',
    state: 'new',
    claimed_by: null,
    claimed_at: null,
    resolved_by: null,
    resolved_at: null,
    linked_review_id: null,
    decision_note: null,
    updated_by: LEAD_ID,
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function seedDatabase(options: { insertError?: { code: string; message: string } } = {}) {
  mockMainDb = createMockSupabase({
    tables: {
      profiles: [
        profile(ALINA_ID, 'admin', 'Алина'),
        profile(SERGEY_ID, 'admin', 'Сергей Лазуткин'),
        profile(ANYA_ID, 'admin', 'Анна'),
        profile(NIKITA_ID, 'admin', 'Nick Sorichev'),
        profile(LEAD_ID, 'lead', 'Лид'),
        profile(DIRECTOR_ID, 'director', 'Директор'),
        profile(MANAGER_ID, 'manager', 'Менеджер'),
        profile(OTHER_ADMIN_ID, 'admin', 'Другой админ'),
        profile(STAFF_ID, 'technician', 'Специалист'),
        profile(CLIENT_ID, 'client', 'Клиент'),
        profile(DEMO_LEAD_ID, 'lead', 'Демо лид', { isDemo: true }),
        profile(EMPLOYEE_ID, 'technician', 'Анна Ким'),
        profile(OTHER_EMPLOYEE_ID, 'manager', 'Иван Петров'),
      ],
      projects: [
        {
          id: PROJECT_ID,
          client: 'Acme',
          name: 'Аутрич',
          status: 'В работе',
        },
        {
          id: UNNAMED_PROJECT_ID,
          client: '',
          name: '',
          status: 'В работе',
        },
        {
          id: EQUAL_PROJECT_ID,
          client: ' Polza ',
          name: 'Polza',
          status: 'В работе',
        },
        {
          id: CASE_EQUAL_PROJECT_ID,
          client: ' Acme Group ',
          name: 'aCmE gRoUp',
          status: 'В работе',
        },
      ],
      team_review_requests: [
        reviewRequest(),
        reviewRequest({
          id: PRIVATE_REQUEST_ID,
          requested_by_user_id: ANYA_ID,
          visibility: 'private',
        }),
        reviewRequest({
          id: IN_PROGRESS_ID,
          employee_user_id: OTHER_EMPLOYEE_ID,
          project_id: null,
          state: 'in_progress',
          claimed_by: ALINA_ID,
          claimed_at: '2026-08-11T09:00:00.000Z',
          updated_by: ALINA_ID,
        }),
        reviewRequest({
          id: CONVERTED_ID,
          state: 'converted',
          linked_review_id: LINKED_REVIEW_ID,
          resolved_by: SERGEY_ID,
          resolved_at: '2026-08-11T10:00:00.000Z',
          updated_by: SERGEY_ID,
        }),
        reviewRequest({
          id: DECLINED_ID,
          state: 'declined',
          resolved_by: ALINA_ID,
          resolved_at: '2026-08-11T11:00:00.000Z',
          decision_note: 'Сначала обсудить внутри команды',
          updated_by: ALINA_ID,
        }),
      ],
    },
    errorInserts: options.insertError
      ? { team_review_requests: options.insertError }
      : undefined,
  });
}

function request(
  pathname: string,
  init: { method?: string; body?: unknown; authenticated?: boolean } = {},
) {
  const headers = new Headers();
  if (init.authenticated !== false) headers.set('authorization', 'Bearer test-token');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`http://portal.local${pathname}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    employeeUserId: EMPLOYEE_ID,
    projectId: PROJECT_ID,
    problem: '  Нужна помощь с приоритизацией  ',
    examples: '  Две задачи сорвали срок  ',
    desiredOutcome: '  Зафиксировать план развития  ',
    ...overrides,
  };
}

function setCurrentUser(userId: string | null) {
  mockCurrentUser = userId ? { id: userId } : null;
}

function expectRoute(pathname: string) {
  expect(fs.existsSync(pathname)).toBe(true);
}

async function loadCollectionRoute() {
  expectRoute(routePath);
  return import('@/app/api/team/review-requests/route');
}

async function loadSummaryRoute() {
  expectRoute(summaryRoutePath);
  return import('@/app/api/team/review-requests/summary/route');
}

async function loadSharedRoute() {
  expectRoute(sharedRoutePath);
  return import('@/app/api/team/review-requests/shared/route');
}

async function loadItemRoute() {
  expectRoute(itemRoutePath);
  return import('@/app/api/team/review-requests/[id]/route');
}

beforeEach(() => {
  jest.resetModules();
  mockCurrentUser = { id: ALINA_ID };
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(async () => ({ data: { user: mockCurrentUser }, error: null }));
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (functionName: string) => ({
    data: functionName === 'can_access_team'
      ? Boolean(mockCurrentUser && PRIVATE_USERS.has(mockCurrentUser.id))
      : functionName === 'can_submit_team_review_request'
        ? Boolean(mockCurrentUser && SUBMITTERS.has(mockCurrentUser.id))
        : functionName === 'can_view_team_review_requests_shared'
          ? Boolean(mockCurrentUser && SHARED_VIEWERS.has(mockCurrentUser.id))
        : false,
    error: null,
  }));
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  seedDatabase();
});

describe('GET /api/team/review-requests', () => {
  it.each([ALINA_ID, SERGEY_ID])(
    'returns the complete private inbox to approved user %s in stable groups',
    async (userId) => {
      setCurrentUser(userId);
      const { GET } = await loadCollectionRoute();

      const response = await GET(request('/api/team/review-requests'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('can_access_team');
      expect(body.canManage).toBe(true);
      expect(body.groups.map((group: { state: string }) => group.state)).toEqual([
        'new',
        'in_progress',
        'converted',
        'declined',
      ]);
      expect(body.groups.map((group: { requests: unknown[] }) => group.requests.length)).toEqual([
        2,
        1,
        1,
        1,
      ]);
      expect(body.summary).toEqual({
        total: 5,
        newCount: 2,
        inProgressCount: 1,
        convertedCount: 1,
        declinedCount: 1,
      });
      expect(body.employees).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: EMPLOYEE_ID, name: 'Анна Ким' }),
      ]));
      expect(body.projects).toEqual(expect.arrayContaining([
        { id: PROJECT_ID, name: 'Acme · Аутрич' },
        { id: UNNAMED_PROJECT_ID, name: 'Проект' },
        { id: EQUAL_PROJECT_ID, name: 'Polza' },
        { id: CASE_EQUAL_PROJECT_ID, name: 'Acme Group' },
      ]));
      expect(body.groups[0].requests[0]).toEqual(expect.objectContaining({
        id: REQUEST_ID,
        state: 'new',
        employee: expect.objectContaining({ id: EMPLOYEE_ID }),
        initiator: expect.objectContaining({ id: LEAD_ID }),
        project: expect.objectContaining({ id: PROJECT_ID }),
        problem: 'Нужна помощь с приоритизацией',
        examples: 'Две задачи сорвали срок на этой неделе',
        desiredOutcome: 'Зафиксировать план развития',
        linkedReviewId: null,
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
      }));
    },
  );

  it.each([
    ['lead', LEAD_ID],
    ['director', DIRECTOR_ID],
    ['Anya', ANYA_ID],
    ['Nikita', NIKITA_ID],
    ['manager', MANAGER_ID],
    ['other admin', OTHER_ADMIN_ID],
    ['staff', STAFF_ID],
    ['client', CLIENT_ID],
    ['demo lead', DEMO_LEAD_ID],
  ])('denies %s before any service-role read', async (_label, userId) => {
    setCurrentUser(userId);
    const { GET } = await loadCollectionRoute();

    const response = await GET(request('/api/team/review-requests'));

    expect(response.status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith('can_access_team');
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it('returns 401 to an anonymous caller without touching the service client', async () => {
    setCurrentUser(null);
    const { GET } = await loadCollectionRoute();

    const response = await GET(request('/api/team/review-requests', { authenticated: false }));

    expect(response.status).toBe(401);
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it('fails closed with 500 when Supabase returns an authentication infrastructure error', async () => {
    mockGetUser.mockImplementationOnce(async () => ({
      data: { user: null },
      error: { message: 'authentication service unavailable' },
    }));
    const { GET } = await loadCollectionRoute();

    const response = await GET(request('/api/team/review-requests'));

    expect(response.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'team.review_requests.auth.failed',
      expect.objectContaining({ message: 'authentication service unavailable' }),
      expect.objectContaining({}),
      expect.objectContaining({ userId: null }),
    );
  });

  it.each([401, 403])(
    'maps an explicit Supabase auth status %s to 401 without infrastructure logging',
    async (status) => {
      mockGetUser.mockImplementationOnce(async () => ({
        data: { user: null },
        error: { message: 'JWT is invalid or expired', status },
      }));
      const { GET } = await loadCollectionRoute();

      const response = await GET(request('/api/team/review-requests'));

      expect(response.status).toBe(401);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockLogError).not.toHaveBeenCalled();
    },
  );

  it('fails closed with 500 when the private capability RPC fails', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'capability unavailable' } });
    const { GET } = await loadCollectionRoute();

    const response = await GET(request('/api/team/review-requests'));

    expect(response.status).toBe(500);
    expect(mockMainDb.selects).toHaveLength(0);
  });
});

describe('GET /api/team/review-requests/shared', () => {
  it.each([
    ['lead', LEAD_ID],
    ['director', DIRECTOR_ID],
  ])('returns only lead-shared requests to a %s as a read-only redacted list', async (_label, userId) => {
    setCurrentUser(userId);
    const { GET } = await loadSharedRoute();

    const response = await GET(request('/api/team/review-requests/shared'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('can_view_team_review_requests_shared');
    expect(body.canManage).toBe(false);
    expect(body.requests.map((item: { id: string }) => item.id)).not.toContain(PRIVATE_REQUEST_ID);
    expect(body.requests).toHaveLength(4);
    expect(body.summary).toEqual({
      total: 4,
      newCount: 1,
      inProgressCount: 1,
      convertedCount: 1,
      declinedCount: 1,
    });

    const item = body.requests.find((candidate: { id: string }) => candidate.id === REQUEST_ID);
    expect(item).toEqual({
      id: REQUEST_ID,
      state: 'new',
      employee: {
        id: EMPLOYEE_ID,
        name: 'Анна Ким',
        avatarUrl: null,
      },
      initiator: {
        id: LEAD_ID,
        name: 'Лид',
        avatarUrl: null,
      },
      project: { id: PROJECT_ID, name: 'Acme · Аутрич' },
      problem: 'Нужна помощь с приоритизацией',
      examples: 'Две задачи сорвали срок на этой неделе',
      desiredOutcome: 'Зафиксировать план развития',
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    });
    expect(item).not.toHaveProperty('claimedBy');
    expect(item).not.toHaveProperty('resolvedBy');
    expect(item).not.toHaveProperty('linkedReviewId');
    expect(item).not.toHaveProperty('decisionNote');
    expect(item.employee).not.toHaveProperty('email');
    expect(item.initiator).not.toHaveProperty('email');

    const sharedSelect = mockMainDb.selects.find(
      (call) => call.table === 'team_review_requests',
    );
    expect(sharedSelect?.columns).not.toMatch(
      /claimed_by|claimed_at|resolved_by|resolved_at|linked_review_id|decision_note|updated_by/,
    );
    expect(fs.readFileSync(sharedRoutePath, 'utf8')).toMatch(
      /\.eq\(\s*['"]visibility['"]\s*,\s*['"]lead_shared['"]\s*\)/,
    );
  });

  it.each([
    ['private HR', ALINA_ID],
    ['private Sergey', SERGEY_ID],
    ['Anya', ANYA_ID],
    ['Nikita', NIKITA_ID],
    ['manager', MANAGER_ID],
    ['other admin', OTHER_ADMIN_ID],
    ['staff', STAFF_ID],
    ['client', CLIENT_ID],
    ['demo lead', DEMO_LEAD_ID],
  ])('denies %s before any service-role read', async (_label, userId) => {
    setCurrentUser(userId);
    const { GET } = await loadSharedRoute();

    const response = await GET(request('/api/team/review-requests/shared'));

    expect(response.status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith('can_view_team_review_requests_shared');
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it('fails closed when the shared-view capability cannot be verified', async () => {
    setCurrentUser(LEAD_ID);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'capability unavailable' } });
    const { GET } = await loadSharedRoute();

    const response = await GET(request('/api/team/review-requests/shared'));

    expect(response.status).toBe(500);
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it('returns 401 to an anonymous caller without touching the service client', async () => {
    setCurrentUser(null);
    const { GET } = await loadSharedRoute();

    const response = await GET(request('/api/team/review-requests/shared', {
      authenticated: false,
    }));

    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
  });
});

describe('GET /api/team/review-requests/summary', () => {
  it('returns only the private new-request count for a lightweight badge', async () => {
    const { GET } = await loadSummaryRoute();

    const response = await GET(request('/api/team/review-requests/summary'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ newCount: 2 });
    expect(mockRpc).toHaveBeenCalledWith('can_access_team');
  });

  it('does not reveal the count to an eligible submitter without private access', async () => {
    setCurrentUser(LEAD_ID);
    const { GET } = await loadSummaryRoute();

    const response = await GET(request('/api/team/review-requests/summary'));

    expect(response.status).toBe(403);
    expect(mockMainDb.selects).toHaveLength(0);
  });
});

describe('POST /api/team/review-requests', () => {
  it.each([
    ['private HR', ALINA_ID, 'private'],
    ['private Sergey', SERGEY_ID, 'private'],
    ['executive Anya', ANYA_ID, 'private'],
    ['executive Nikita', NIKITA_ID, 'private'],
    ['lead', LEAD_ID, 'lead_shared'],
    ['director', DIRECTOR_ID, 'lead_shared'],
  ])('allows %s to submit and derives actor and visibility on the server', async (
    _label,
    userId,
    expectedVisibility,
  ) => {
    setCurrentUser(userId);
    const { POST } = await loadCollectionRoute();
    const spoofedActor = '00000000-0000-4000-8000-000000000099';

    const response = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody({
        requestedByUserId: spoofedActor,
        visibility: expectedVisibility === 'private' ? 'lead_shared' : 'private',
      }),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ requestId: expect.any(String) });
    expect(mockRpc).toHaveBeenCalledWith('can_submit_team_review_request');
    const inserted = mockMainDb.inserts.find((call) => call.table === 'team_review_requests');
    expect(inserted?.rows[0]).toEqual(expect.objectContaining({
      employee_user_id: EMPLOYEE_ID,
      requested_by_user_id: userId,
      project_id: PROJECT_ID,
      problem: 'Нужна помощь с приоритизацией',
      examples: 'Две задачи сорвали срок',
      desired_outcome: 'Зафиксировать план развития',
      state: 'new',
      visibility: expectedVisibility,
      updated_by: userId,
    }));
    expect(inserted?.rows[0]?.requested_by_user_id).not.toBe(spoofedActor);
  });

  it.each([
    ['manager', MANAGER_ID],
    ['other admin', OTHER_ADMIN_ID],
    ['staff', STAFF_ID],
    ['client', CLIENT_ID],
    ['demo lead', DEMO_LEAD_ID],
  ])('denies %s before validation or service-role access', async (_label, userId) => {
    setCurrentUser(userId);
    const { POST } = await loadCollectionRoute();

    const response = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody(),
    }));

    expect(response.status).toBe(403);
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it('lets a lead submit but still denies the private inbox afterwards', async () => {
    setCurrentUser(LEAD_ID);
    const route = await loadCollectionRoute();

    const created = await route.POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody(),
    }));
    expect(created.status).toBe(201);

    mockMainDb.selects.length = 0;
    mockRpc.mockClear();
    const listed = await route.GET(request('/api/team/review-requests'));

    expect(listed.status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith('can_access_team');
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it.each([
    ['missing problem', validCreateBody({ problem: undefined })],
    ['blank problem', validCreateBody({ problem: '   ' })],
    ['long problem', validCreateBody({ problem: 'p'.repeat(501) })],
    ['long examples', validCreateBody({ examples: 'e'.repeat(5001) })],
    ['missing desired outcome', validCreateBody({ desiredOutcome: undefined })],
    ['long desired outcome', validCreateBody({ desiredOutcome: 'o'.repeat(1001) })],
    ['invalid employee UUID', validCreateBody({ employeeUserId: 'not-a-uuid' })],
    ['invalid project UUID', validCreateBody({ projectId: 'not-a-uuid' })],
  ])('rejects %s without inserting', async (_label, body) => {
    setCurrentUser(LEAD_ID);
    const { POST } = await loadCollectionRoute();

    const response = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body,
    }));

    expect(response.status).toBe(400);
    expect(mockMainDb.inserts).toHaveLength(0);
  });

  it.each([
    ['client target', CLIENT_ID],
    ['demo target', DEMO_LEAD_ID],
    ['missing target', '00000000-0000-4000-8000-000000000098'],
  ])('rejects a %s as the review subject', async (_label, employeeUserId) => {
    setCurrentUser(LEAD_ID);
    const { POST } = await loadCollectionRoute();

    const response = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody({ employeeUserId }),
    }));

    expect(response.status).toBe(400);
    expect(mockMainDb.inserts).toHaveLength(0);
  });

  it('rejects a missing project while allowing an explicit null project', async () => {
    setCurrentUser(LEAD_ID);
    const { POST } = await loadCollectionRoute();

    const missing = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody({ projectId: '00000000-0000-4000-8000-000000000097' }),
    }));
    expect(missing.status).toBe(400);
    expect(mockMainDb.inserts).toHaveLength(0);

    const withoutProject = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody({ projectId: null }),
    }));
    expect(withoutProject.status).toBe(201);
    expect(mockMainDb.inserts[0]?.rows[0]?.project_id).toBeNull();
  });

  it('maps the unresolved-request unique race to 409', async () => {
    setCurrentUser(LEAD_ID);
    seedDatabase({ insertError: { code: '23505', message: 'duplicate unresolved request' } });
    const { POST } = await loadCollectionRoute();

    const response = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody(),
    }));

    expect(response.status).toBe(409);
  });

  it('keeps sensitive request text out of audit context', async () => {
    setCurrentUser(LEAD_ID);
    const { POST } = await loadCollectionRoute();

    const response = await POST(request('/api/team/review-requests', {
      method: 'POST',
      body: validCreateBody(),
    }));

    expect(response.status).toBe(201);
    const serializedAudit = JSON.stringify(mockLogAudit.mock.calls);
    expect(serializedAudit).not.toContain('Нужна помощь с приоритизацией');
    expect(serializedAudit).not.toContain('Две задачи сорвали срок');
    expect(serializedAudit).not.toContain('Зафиксировать план развития');
  });
});

describe('PATCH /api/team/review-requests/[id]', () => {
  it('lets a private user claim a new request with optimistic concurrency', async () => {
    const { PATCH } = await loadItemRoute();

    const response = await PATCH(
      request(`/api/team/review-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { action: 'claim', expectedUpdatedAt: UPDATED_AT },
      }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(200);
    const update = mockMainDb.updates.find((call) => call.table === 'team_review_requests');
    expect(update?.patch).toEqual(expect.objectContaining({
      state: 'in_progress',
      claimed_by: ALINA_ID,
      claimed_at: expect.any(String),
      updated_by: ALINA_ID,
    }));
    expect(update?.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'id', value: REQUEST_ID }),
      expect.objectContaining({ column: 'updated_at', value: UPDATED_AT }),
      expect.objectContaining({ column: 'state', value: 'new' }),
    ]));
  });

  it('lets a private user decline a new request and bounds the decision note', async () => {
    const { PATCH } = await loadItemRoute();

    const response = await PATCH(
      request(`/api/team/review-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: {
          action: 'decline',
          decisionNote: 'Сначала обсудить внутри команды',
          expectedUpdatedAt: UPDATED_AT,
        },
      }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(200);
    const update = mockMainDb.updates.find((call) => call.table === 'team_review_requests');
    expect(update?.patch).toEqual(expect.objectContaining({
      state: 'declined',
      decision_note: 'Сначала обсудить внутри команды',
      resolved_by: ALINA_ID,
      resolved_at: expect.any(String),
      updated_by: ALINA_ID,
    }));

    const tooLong = await PATCH(
      request(`/api/team/review-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: {
          action: 'decline',
          decisionNote: 'x'.repeat(1001),
          expectedUpdatedAt: UPDATED_AT,
        },
      }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );
    expect(tooLong.status).toBe(400);
  });

  it.each([
    ['missing precondition', { action: 'claim' }, 428],
    ['invalid precondition', { action: 'claim', expectedUpdatedAt: 'yesterday' }, 400],
    ['invalid action', { action: 'complete', expectedUpdatedAt: UPDATED_AT }, 400],
  ])('rejects %s', async (_label, body, expectedStatus) => {
    const { PATCH } = await loadItemRoute();

    const response = await PATCH(
      request(`/api/team/review-requests/${REQUEST_ID}`, { method: 'PATCH', body }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(expectedStatus);
  });

  it('returns 409 for a stale claim without overwriting the current request', async () => {
    const { PATCH } = await loadItemRoute();

    const response = await PATCH(
      request(`/api/team/review-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { action: 'claim', expectedUpdatedAt: '2026-08-10T08:00:00.000Z' },
      }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(409);
    expect(mockMainDb.getRows('team_review_requests').find((row) => row.id === REQUEST_ID)?.state)
      .toBe('new');
  });

  it.each([LEAD_ID, DIRECTOR_ID, ANYA_ID, NIKITA_ID, MANAGER_ID, OTHER_ADMIN_ID])(
    'denies non-private caller %s before service-role reads and writes',
    async (userId) => {
      setCurrentUser(userId);
      const { PATCH } = await loadItemRoute();

      const response = await PATCH(
        request(`/api/team/review-requests/${REQUEST_ID}`, {
          method: 'PATCH',
          body: { action: 'claim', expectedUpdatedAt: UPDATED_AT },
        }),
        { params: Promise.resolve({ id: REQUEST_ID }) },
      );

      expect(response.status).toBe(403);
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
    },
  );
});
