/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const ALINA_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const SERGEY_ID = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
const SPOOFED_ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000010';
const ATTENTION_TODAY_ID = '00000000-0000-4000-8000-000000000011';
const ACTIVE_NEW_ID = '00000000-0000-4000-8000-000000000012';
const ACTIVE_RESERVE_ID = '00000000-0000-4000-8000-000000000013';
const RETURN_LATER_FUTURE_ID = '00000000-0000-4000-8000-000000000017';
const HISTORY_HIRED_ID = '00000000-0000-4000-8000-000000000014';
const HISTORY_REJECTED_ID = '00000000-0000-4000-8000-000000000015';
const HISTORY_ARCHIVED_ID = '00000000-0000-4000-8000-000000000016';
const UNKNOWN_ENTRY_ID = '00000000-0000-4000-8000-000000000099';
const ENTRY_UPDATED_AT = '2026-08-01T09:00:00.000Z';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockCurrentUser: { id: string } | null = { id: ALINA_ID };
const PRIVATE_TEAM_USERS = new Set([ALINA_ID, SERGEY_ID]);
const mockGetUser = jest.fn(async () => ({ data: { user: mockCurrentUser } }));
const mockTeamAccessCapability = jest.fn(
  async (
    _functionName: string,
  ): Promise<{ data: boolean | null; error: { message: string } | null }> => ({
    data: Boolean(mockCurrentUser && PRIVATE_TEAM_USERS.has(mockCurrentUser.id)),
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
    rpc: (functionName: string) => mockTeamAccessCapability(functionName),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

function talentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    contact: 'https://t.me/candidate',
    candidate_name: 'Мария Кандидатова',
    vacancy_direction: 'Аккаунт-менеджер',
    test_assignment: 'Подготовить разбор кейса',
    test_result: 'Хороший результат',
    test_sent_on: '2026-08-05',
    interview_on: '2026-08-10',
    revisit_on: null,
    comment: 'Сильная коммуникация',
    revisit_note: null,
    stage: 'interview',
    created_by: ALINA_ID,
    updated_by: ALINA_ID,
    created_at: '2026-07-30T08:00:00.000Z',
    updated_at: ENTRY_UPDATED_AT,
    ...overrides,
  };
}

function seedDatabase() {
  mockMainDb = createMockSupabase({
    tables: {
      // Deliberately scrambled: the API, not seed order, owns the stable ordering.
      team_talent_reserve_entries: [
        talentRow({
          id: HISTORY_REJECTED_ID,
          candidate_name: 'Rejected candidate',
          stage: 'rejected',
          interview_on: null,
          updated_at: '2026-08-10T12:00:00.000Z',
        }),
        talentRow({
          id: ACTIVE_RESERVE_ID,
          candidate_name: 'Reserve candidate',
          stage: 'reserve',
          interview_on: '2026-08-01',
          updated_at: '2026-08-09T12:00:00.000Z',
        }),
        talentRow({
          id: RETURN_LATER_FUTURE_ID,
          candidate_name: 'Return later after a historical interview',
          stage: 'return_later',
          interview_on: '2026-08-01',
          revisit_on: '2026-08-20',
          updated_at: '2026-08-08T12:00:00.000Z',
        }),
        talentRow({
          id: ATTENTION_TODAY_ID,
          candidate_name: 'Return today',
          stage: 'return_later',
          interview_on: null,
          revisit_on: '2026-08-11',
          updated_at: '2026-08-02T12:00:00.000Z',
        }),
        talentRow({
          id: HISTORY_ARCHIVED_ID,
          candidate_name: 'Archived candidate',
          stage: 'archived',
          interview_on: null,
          updated_at: '2026-08-09T12:00:00.000Z',
        }),
        talentRow({
          id: ACTIVE_NEW_ID,
          candidate_name: 'New candidate',
          stage: 'new',
          interview_on: null,
          updated_at: '2026-08-10T18:00:00.000Z',
        }),
        talentRow({
          id: HISTORY_HIRED_ID,
          candidate_name: 'Hired candidate',
          stage: 'hired',
          interview_on: '2026-08-01',
          updated_at: '2026-08-11T12:00:00.000Z',
        }),
        talentRow(),
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
    contact: '  https://t.me/new_candidate  ',
    candidateName: '  Анна Кандидат  ',
    vacancyDirection: '  Продажи / Account Executive  ',
    testAssignment: '  Подготовить тестовый outreach-план  ',
    testResult: '  Выполнено уверенно  ',
    testSentOn: '2026-08-03',
    interviewOn: '2026-08-08',
    revisitOn: null,
    comment: '  Вернуться после финального интервью  ',
    revisitNote: null,
    stage: 'interview',
  };
}

async function invoke(
  method: Method,
  options: {
    authenticated?: boolean;
    body?: unknown;
    id?: string;
  } = {},
) {
  if (method === 'GET') {
    const { GET } = await import('@/app/api/team/talent-reserve/route');
    return GET(request('/api/team/talent-reserve', {
      authenticated: options.authenticated,
    }));
  }

  if (method === 'POST') {
    const { POST } = await import('@/app/api/team/talent-reserve/route');
    return POST(request('/api/team/talent-reserve', {
      method,
      authenticated: options.authenticated,
      body: options.body ?? validCreateBody(),
    }));
  }

  const id = options.id ?? ENTRY_ID;
  const route = await import('@/app/api/team/talent-reserve/[id]/route');
  const body = options.body ?? (
    method === 'PATCH'
      ? { expectedUpdatedAt: ENTRY_UPDATED_AT, comment: 'Обновлённый комментарий' }
      : { expectedUpdatedAt: ENTRY_UPDATED_AT }
  );
  const req = request(`/api/team/talent-reserve/${id}`, {
    method,
    authenticated: options.authenticated,
    body,
  });
  const context = { params: Promise.resolve({ id }) };
  return method === 'PATCH'
    ? route.PATCH(req, context)
    : route.DELETE(req, context);
}

function talentSelects() {
  return mockMainDb.selects.filter(
    (call) => call.table === 'team_talent_reserve_entries',
  );
}

function successAuditEvents() {
  return mockLogAudit.mock.calls
    .map(([event]) => event)
    .filter((event) => typeof event === 'string' && event.endsWith('.success'));
}

function instrumentTalentDeleteFilters() {
  const baseDb = mockMainDb;
  const filters: Array<{ column: string; value: unknown }> = [];
  mockMainDb = {
    ...baseDb,
    from: (table: string) => {
      const target = baseDb.from(table) as unknown as Record<PropertyKey, unknown>;
      let deleting = false;
      const proxy: Record<PropertyKey, unknown> = new Proxy(target, {
        get(object, property, receiver) {
          const value = Reflect.get(object, property, receiver);
          if (typeof value !== 'function') return value;
          if (property === 'delete') {
            return (...args: unknown[]) => {
              deleting = true;
              Reflect.apply(value, object, args);
              return proxy;
            };
          }
          if (property === 'eq') {
            return (column: string, filterValue: unknown) => {
              if (deleting && table === 'team_talent_reserve_entries') {
                filters.push({ column, value: filterValue });
              }
              Reflect.apply(value, object, [column, filterValue]);
              return proxy;
            };
          }
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, object, args);
            return result === object ? proxy : result;
          };
        },
      });
      return proxy as never;
    },
  };
  return filters;
}

function instrumentTalentRaceAfterFirstRead(
  mutation: (from: MockSupabaseClient['from']) => Promise<unknown>,
) {
  const originalFrom = mockMainDb.from;
  let injected = false;

  mockMainDb.from = (table) => {
    const builder = originalFrom(table);
    if (table !== 'team_talent_reserve_entries' || injected) return builder;

    const maybeSingle = builder.maybeSingle.bind(builder);
    builder.maybeSingle = async () => {
      const result = await maybeSingle();
      if (!injected && result.data?.id === ENTRY_ID) {
        injected = true;
        await mutation(originalFrom);
      }
      return result;
    };
    return builder;
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  // Current calendar day is already August 11 in Europe/Moscow.
  jest.setSystemTime(new Date('2026-08-10T21:30:00.000Z'));
  mockCurrentUser = { id: ALINA_ID };
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(async () => ({ data: { user: mockCurrentUser } }));
  mockTeamAccessCapability.mockReset();
  mockTeamAccessCapability.mockImplementation(async () => ({
    data: Boolean(mockCurrentUser && PRIVATE_TEAM_USERS.has(mockCurrentUser.id)),
    error: null,
  }));
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  seedDatabase();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('team talent reserve authorization', () => {
  it.each<Method>(['GET', 'POST', 'PATCH', 'DELETE'])(
    'rejects anonymous %s before auth or service-role database access',
    async (method) => {
      const response = await invoke(method, { authenticated: false });

      expect(response.status).toBe(401);
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockTeamAccessCapability).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it('rejects an invalid bearer session before capability or database access', async () => {
    mockCurrentUser = null;

    const response = await invoke('GET');

    expect(response.status).toBe(401);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(mockTeamAccessCapability).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it.each([undefined, 503] as const)(
    'returns 500 for an unknown or infrastructure auth error returned by getUser (%s)',
    async (status) => {
      const authError = status === undefined
        ? { message: 'auth lookup unavailable' }
        : { message: 'auth lookup unavailable', status };
      mockGetUser.mockResolvedValueOnce({
        data: { user: null },
        error: authError,
      } as never);

      const response = await invoke('GET');

      expect(response.status).toBe(500);
      expect(mockTeamAccessCapability).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(mockLogError).toHaveBeenCalledWith(
        'team.talent_reserve.auth.failed',
        authError,
        {},
        expect.objectContaining({
          userId: null,
          route: '/api/team/talent-reserve',
        }),
      );
    },
  );

  it.each([
    ['returned', 401],
    ['returned', 403],
    ['thrown', 401],
    ['thrown', 403],
  ] as const)(
    'returns 401 without infrastructure logging for an explicitly invalid session (%s %s)',
    async (delivery, status) => {
      const authError = Object.assign(new Error('invalid or expired session'), { status });
      if (delivery === 'returned') {
        mockGetUser.mockResolvedValueOnce({
          data: { user: null },
          error: authError,
        } as never);
      } else {
        mockGetUser.mockRejectedValueOnce(authError);
      }

      const response = await invoke('GET');

      expect(response.status).toBe(401);
      expect(mockTeamAccessCapability).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(mockLogError).not.toHaveBeenCalled();
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it('returns 500 and safely logs a thrown auth infrastructure error', async () => {
    const authError = new Error('auth service unavailable');
    mockGetUser.mockRejectedValueOnce(authError);

    const response = await invoke('GET');

    expect(response.status).toBe(500);
    expect(mockTeamAccessCapability).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'team.talent_reserve.auth.failed',
      authError,
      {},
      expect.objectContaining({
        userId: null,
        route: '/api/team/talent-reserve',
      }),
    );
  });

  it('fails closed and logs when the caller-JWT capability RPC returns an error', async () => {
    const rpcError = { message: 'private Team capability unavailable' };
    mockTeamAccessCapability.mockResolvedValueOnce({ data: null, error: rpcError });

    const response = await invoke('GET');

    expect(response.status).toBe(500);
    expect(mockTeamAccessCapability).toHaveBeenCalledWith('can_access_team');
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'team.talent_reserve.auth.failed',
      rpcError,
      {},
      expect.objectContaining({ userId: ALINA_ID }),
    );
  });

  it('fails closed when the caller-JWT capability RPC throws', async () => {
    const rpcError = new Error('RPC transport failed');
    mockTeamAccessCapability.mockRejectedValueOnce(rpcError);

    const response = await invoke('GET');

    expect(response.status).toBe(500);
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'team.talent_reserve.auth.failed',
      rpcError,
      {},
      expect.objectContaining({ userId: ALINA_ID }),
    );
  });

  it.each([ALINA_ID, SERGEY_ID])(
    'allows an approved private-Team user %s through the full CRUD matrix',
    async (userId) => {
      mockCurrentUser = { id: userId };

      const responses = [
        await invoke('GET'),
        await invoke('POST'),
        await invoke('PATCH'),
        await invoke('DELETE'),
      ];

      expect(responses.map((response) => response.status)).toEqual([200, 201, 200, 204]);
      expect(mockTeamAccessCapability.mock.calls).toEqual([
        ['can_access_team'],
        ['can_access_team'],
        ['can_access_team'],
        ['can_access_team'],
      ]);
    },
  );

  it.each([
    ['technician', '00000000-0000-4000-8000-000000000020'],
    ['manager', '00000000-0000-4000-8000-000000000021'],
    ['director', '00000000-0000-4000-8000-000000000022'],
    ['admin', '00000000-0000-4000-8000-000000000023'],
    ['sales', '00000000-0000-4000-8000-000000000024'],
    ['marketer', '00000000-0000-4000-8000-000000000025'],
    ['lead', '00000000-0000-4000-8000-000000000026'],
    ['demo account', '00000000-0000-4000-8000-000000000027'],
    ['client', '00000000-0000-4000-8000-000000000028'],
  ])('denies an unapproved %s before service-role access', async (_label, userId) => {
    mockCurrentUser = { id: userId };

    const response = await invoke('GET');

    expect(response.status).toBe(403);
    expect(mockTeamAccessCapability).toHaveBeenCalledWith('can_access_team');
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it.each<Method>(['POST', 'PATCH', 'DELETE'])(
    'denies an unapproved user through %s before parsing or database access',
    async (method) => {
      mockCurrentUser = { id: '00000000-0000-4000-8000-000000000023' };

      const response = await invoke(method, { body: { invalid: true } });

      expect(response.status).toBe(403);
      expect(mockTeamAccessCapability).toHaveBeenCalledWith('can_access_team');
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );
});

describe('GET /api/team/talent-reserve', () => {
  it('returns canonical camelCase entries, summaries and stable attention-first ordering', async () => {
    const response = await invoke('GET');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      asOf: '2026-08-11',
      canManage: true,
      summary: {
        total: 8,
        attentionCount: 2,
        activeCount: 5,
        historyCount: 3,
      },
    }));
    expect(body.entries.map((entry: { id: string }) => entry.id)).toEqual([
      ENTRY_ID,
      ATTENTION_TODAY_ID,
      ACTIVE_NEW_ID,
      ACTIVE_RESERVE_ID,
      RETURN_LATER_FUTURE_ID,
      HISTORY_HIRED_ID,
      HISTORY_REJECTED_ID,
      HISTORY_ARCHIVED_ID,
    ]);
    expect(body.entries[0]).toEqual({
      id: ENTRY_ID,
      contact: 'https://t.me/candidate',
      candidateName: 'Мария Кандидатова',
      vacancyDirection: 'Аккаунт-менеджер',
      testAssignment: 'Подготовить разбор кейса',
      testResult: 'Хороший результат',
      testSentOn: '2026-08-05',
      interviewOn: '2026-08-10',
      revisitOn: null,
      comment: 'Сильная коммуникация',
      revisitNote: null,
      stage: 'interview',
      createdBy: ALINA_ID,
      updatedBy: ALINA_ID,
      createdAt: '2026-07-30T08:00:00.000Z',
      updatedAt: ENTRY_UPDATED_AT,
    });
    // A historical interview date must not be counted as current attention.
    expect(body.entries.find((entry: { id: string }) => entry.id === ACTIVE_RESERVE_ID))
      .toEqual(expect.objectContaining({ stage: 'reserve', interviewOn: '2026-08-01' }));
    expect(body.entries.find((entry: { id: string }) => entry.id === RETURN_LATER_FUTURE_ID))
      .toEqual(expect.objectContaining({
        stage: 'return_later',
        interviewOn: '2026-08-01',
        revisitOn: '2026-08-20',
      }));
    expect(body.entries.find((entry: { id: string }) => entry.id === HISTORY_HIRED_ID))
      .toEqual(expect.objectContaining({ stage: 'hired', interviewOn: '2026-08-01' }));
  });
});

describe('POST /api/team/talent-reserve', () => {
  it('creates a normalized canonical row and ignores actor/timestamp spoofing', async () => {
    const privateContact = 'private-candidate@example.com';
    const response = await invoke('POST', {
      body: {
        ...validCreateBody(),
        contact: `  ${privateContact}  `,
        createdBy: SPOOFED_ACTOR_ID,
        created_by: SPOOFED_ACTOR_ID,
        updatedBy: SPOOFED_ACTOR_ID,
        updated_by: SPOOFED_ACTOR_ID,
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockMainDb.inserts).toContainEqual({
      table: 'team_talent_reserve_entries',
      rows: [
        expect.objectContaining({
          contact: privateContact,
          candidate_name: 'Анна Кандидат',
          vacancy_direction: 'Продажи / Account Executive',
          test_assignment: 'Подготовить тестовый outreach-план',
          test_result: 'Выполнено уверенно',
          test_sent_on: '2026-08-03',
          interview_on: '2026-08-08',
          revisit_on: null,
          comment: 'Вернуться после финального интервью',
          revisit_note: null,
          stage: 'interview',
          created_by: ALINA_ID,
          updated_by: ALINA_ID,
        }),
      ],
    });
    const inserted = mockMainDb.inserts.at(-1)?.rows[0];
    expect(inserted).not.toHaveProperty('created_at');
    expect(inserted).not.toHaveProperty('updated_at');
    expect(inserted).not.toHaveProperty('createdBy');
    expect(inserted).not.toHaveProperty('updatedBy');
    expect(body.entry).toEqual(expect.objectContaining({
      contact: privateContact,
      candidateName: 'Анна Кандидат',
      vacancyDirection: 'Продажи / Account Executive',
      stage: 'interview',
      createdBy: ALINA_ID,
      updatedBy: ALINA_ID,
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.talent_reserve.create.success',
      'Talent reserve entry created',
      expect.objectContaining({
        entryId: expect.any(String),
        stage: 'interview',
      }),
      expect.objectContaining({ userId: ALINA_ID }),
    );
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(privateContact);
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('Анна Кандидат');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('outreach-план');
  });

  it('defaults stage to new and normalizes blank optional text to null', async () => {
    const response = await invoke('POST', {
      body: {
        contact: '  @candidate  ',
        candidateName: '  Candidate  ',
        vacancyDirection: '  Marketing  ',
        testAssignment: '   ',
        testResult: null,
        testSentOn: null,
        interviewOn: null,
        revisitOn: null,
        comment: '   ',
        revisitNote: '   ',
      },
    });

    expect(response.status).toBe(201);
    expect(mockMainDb.inserts.at(-1)?.rows[0]).toEqual(expect.objectContaining({
      contact: '@candidate',
      candidate_name: 'Candidate',
      vacancy_direction: 'Marketing',
      test_assignment: null,
      test_result: null,
      test_sent_on: null,
      interview_on: null,
      revisit_on: null,
      comment: null,
      revisit_note: null,
      stage: 'new',
    }));
  });

  it.each([
    ['contact', { contact: '   ' }],
    ['contact', { contact: 'x'.repeat(501) }],
    ['candidateName', { candidateName: '   ' }],
    ['candidateName', { candidateName: 'x'.repeat(201) }],
    ['vacancyDirection', { vacancyDirection: '   ' }],
    ['vacancyDirection', { vacancyDirection: 'x'.repeat(501) }],
    ['testAssignment', { testAssignment: 'x'.repeat(5001) }],
    ['testResult', { testResult: 'x'.repeat(501) }],
    ['comment', { comment: 'x'.repeat(5001) }],
    ['revisitNote', { revisitNote: 'x'.repeat(501) }],
    ['testSentOn', { testSentOn: '2026-02-30' }],
    ['interviewOn', { interviewOn: '2026-8-08' }],
    ['revisitOn', { revisitOn: 123 }],
    ['stage', { stage: 'screening' }],
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

  it('requires all three required fields even when their keys are omitted', async () => {
    for (const field of ['contact', 'candidateName', 'vacancyDirection'] as const) {
      const body: Record<string, unknown> = { ...validCreateBody() };
      delete body[field];

      const response = await invoke('POST', { body });

      expect(response.status).toBe(400);
    }
    expect(mockMainDb.inserts).toHaveLength(0);
  });

  it('rejects return_later without either a revisit date or meaningful note', async () => {
    const response = await invoke('POST', {
      body: {
        ...validCreateBody(),
        stage: 'return_later',
        revisitOn: null,
        revisitNote: '   ',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('return_later');
    expect(mockMainDb.inserts).toHaveLength(0);
  });

  it.each([
    [{ revisitOn: '2026-10-01', revisitNote: null }],
    [{ revisitOn: null, revisitNote: 'Вернуться после закрытия вакансии' }],
  ])('accepts either supported return_later reminder mode', async (reminder) => {
    const response = await invoke('POST', {
      body: {
        ...validCreateBody(),
        stage: 'return_later',
        interviewOn: null,
        ...reminder,
      },
    });

    expect(response.status).toBe(201);
    expect(mockMainDb.inserts.at(-1)?.rows[0]).toEqual(expect.objectContaining({
      stage: 'return_later',
      revisit_on: reminder.revisitOn,
      revisit_note: reminder.revisitNote,
    }));
  });

  it('does not leak candidate PII into failed-write logs', async () => {
    const privateContact = 'secret-candidate@example.com';
    mockMainDb = createMockSupabase({
      errorTables: {
        team_talent_reserve_entries: `insert failed for ${privateContact}`,
      },
    });

    const response = await invoke('POST', {
      body: {
        ...validCreateBody(),
        contact: privateContact,
        candidateName: 'Secret Candidate',
        comment: 'Confidential recruiting note',
      },
    });

    expect(response.status).toBe(500);
    expect(successAuditEvents()).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalled();
    const serializedLogs = JSON.stringify(mockLogError.mock.calls);
    expect(serializedLogs).not.toContain(privateContact);
    expect(serializedLogs).not.toContain('Secret Candidate');
    expect(serializedLogs).not.toContain('Confidential recruiting note');
  });
});

describe('PATCH /api/team/talent-reserve/[id]', () => {
  it('normalizes accepted fields, applies an id+updated_at CAS guard and owns updatedBy', async () => {
    mockCurrentUser = { id: SERGEY_ID };
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ENTRY_UPDATED_AT,
        candidateName: '  Мария Обновлённая  ',
        stage: 'reserve',
        interviewOn: null,
        comment: '   ',
        createdBy: SPOOFED_ACTOR_ID,
        created_by: SPOOFED_ACTOR_ID,
        updatedBy: SPOOFED_ACTOR_ID,
        updated_by: SPOOFED_ACTOR_ID,
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockMainDb.updates.at(-1)).toEqual(expect.objectContaining({
      table: 'team_talent_reserve_entries',
      patch: expect.objectContaining({
        candidate_name: 'Мария Обновлённая',
        stage: 'reserve',
        interview_on: null,
        comment: null,
        updated_by: SERGEY_ID,
      }),
      filters: expect.arrayContaining([
        { column: 'id', op: 'eq', value: ENTRY_ID },
        { column: 'updated_at', op: 'eq', value: ENTRY_UPDATED_AT },
      ]),
    }));
    const patch = mockMainDb.updates.at(-1)?.patch;
    expect(patch).not.toHaveProperty('expectedUpdatedAt');
    expect(patch).not.toHaveProperty('created_by');
    expect(patch).not.toHaveProperty('created_at');
    expect(patch).not.toHaveProperty('updated_at');
    expect(body.entry).toEqual(expect.objectContaining({
      id: ENTRY_ID,
      candidateName: 'Мария Обновлённая',
      stage: 'reserve',
      updatedBy: SERGEY_ID,
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.talent_reserve.update.success',
      'Talent reserve entry updated',
      expect.objectContaining({
        entryId: ENTRY_ID,
        changedFields: expect.arrayContaining([
          'candidate_name',
          'stage',
          'interview_on',
          'comment',
        ]),
      }),
      expect.objectContaining({ userId: SERGEY_ID }),
    );
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('Мария Обновлённая');
  });

  it('returns the canonical CAS update result without a fallible post-commit reload', async () => {
    const originalFrom = mockMainDb.from;
    let updateCommitted = false;
    let postCommitReads = 0;

    mockMainDb.from = (table) => {
      const builder = originalFrom(table);
      if (table !== 'team_talent_reserve_entries') return builder;

      if (updateCommitted) {
        postCommitReads += 1;
        builder.single = async () => ({
          data: null,
          error: { message: 'post-commit read unavailable' },
        });
      }

      let isUpdateBuilder = false;
      const update = builder.update.bind(builder);
      builder.update = (patch) => {
        isUpdateBuilder = true;
        return update(patch);
      };
      const maybeSingle = builder.maybeSingle.bind(builder);
      builder.maybeSingle = async () => {
        const result = await maybeSingle();
        if (isUpdateBuilder && result.data) updateCommitted = true;
        return result;
      };
      return builder;
    };

    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ENTRY_UPDATED_AT,
        candidateName: 'Atomic canonical candidate',
        comment: 'Atomic canonical comment',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(postCommitReads).toBe(0);
    const projections = talentSelects().map(({ columns }) => columns);
    expect(projections).toHaveLength(2);
    expect(projections[1]).toBe(projections[0]);
    expect(body.entry).toEqual(expect.objectContaining({
      id: ENTRY_ID,
      candidateName: 'Atomic canonical candidate',
      comment: 'Atomic canonical comment',
      updatedBy: ALINA_ID,
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.talent_reserve.update.success',
      'Talent reserve entry updated',
      expect.objectContaining({
        entryId: ENTRY_ID,
        changedFields: expect.arrayContaining(['candidate_name', 'comment']),
      }),
      expect.objectContaining({ userId: ALINA_ID }),
    );
    const serializedAudit = JSON.stringify(mockLogAudit.mock.calls);
    expect(serializedAudit).not.toContain('Atomic canonical candidate');
    expect(serializedAudit).not.toContain('Atomic canonical comment');
  });

  it('rejects changing stage to return_later without a reminder', async () => {
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ENTRY_UPDATED_AT,
        stage: 'return_later',
        interviewOn: null,
        revisitOn: null,
        revisitNote: null,
      },
    });

    expect(response.status).toBe(400);
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('rejects clearing the last reminder from a stored return_later entry', async () => {
    const stored = mockMainDb.getRows('team_talent_reserve_entries')
      .find((entry) => entry.id === ATTENTION_TODAY_ID);
    const response = await invoke('PATCH', {
      id: ATTENTION_TODAY_ID,
      body: {
        expectedUpdatedAt: stored?.updated_at,
        revisitOn: null,
      },
    });

    expect(response.status).toBe(400);
    expect(mockMainDb.updates).toHaveLength(0);
  });

  it('requires expectedUpdatedAt before reading or updating an entry', async () => {
    const response = await invoke('PATCH', {
      body: { comment: 'Попытка без версии' },
    });
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body).toEqual(expect.objectContaining({ code: 'precondition_required' }));
    expect(talentSelects()).toHaveLength(0);
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it.each([null, 'not-a-timestamp', '2026-08-01T09:00:00', '2026-02-30T09:00:00Z'])(
    'rejects invalid expectedUpdatedAt %# before updating',
    async (expectedUpdatedAt) => {
      const response = await invoke('PATCH', {
        body: { expectedUpdatedAt, comment: 'Невалидная версия' },
      });

      expect(response.status).toBe(400);
      expect(mockMainDb.updates).toHaveLength(0);
      expect(successAuditEvents()).toHaveLength(0);
    },
  );

  it('returns 409 for a stale update without changing data or auditing success', async () => {
    const before = mockMainDb.getRows('team_talent_reserve_entries');
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: '2026-08-01T08:59:59.000Z',
        comment: 'Устаревшая правка',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      code: 'talent_reserve_conflict',
      currentUpdatedAt: ENTRY_UPDATED_AT,
    }));
    expect(mockMainDb.getRows('team_talent_reserve_entries')).toEqual(before);
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('returns 409 with the newest version when the CAS update loses a race', async () => {
    const concurrentlyUpdatedAt = '2026-08-02T10:20:30.123456Z';
    instrumentTalentRaceAfterFirstRead(async (from) => {
      await from('team_talent_reserve_entries')
        .update({ updated_at: concurrentlyUpdatedAt })
        .eq('id', ENTRY_ID);
    });

    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ENTRY_UPDATED_AT,
        comment: 'This losing write must not overwrite the concurrent version',
      },
    });
    const body = await response.json();
    const current = mockMainDb.getRows('team_talent_reserve_entries')
      .find((entry) => entry.id === ENTRY_ID);

    expect(response.status).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      code: 'talent_reserve_conflict',
      currentUpdatedAt: concurrentlyUpdatedAt,
    }));
    expect(current).toEqual(expect.objectContaining({
      updated_at: concurrentlyUpdatedAt,
    }));
    expect(current?.comment)
      .not.toBe('This losing write must not overwrite the concurrent version');
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('returns 404 when the entry is deleted after the preliminary read', async () => {
    instrumentTalentRaceAfterFirstRead(async (from) => {
      await from('team_talent_reserve_entries')
        .delete()
        .eq('id', ENTRY_ID);
    });

    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ENTRY_UPDATED_AT,
        comment: 'This write must not resurrect a deleted entry',
      },
    });

    expect(response.status).toBe(404);
    expect(mockMainDb.getRows('team_talent_reserve_entries'))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: ENTRY_ID })]));
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('rejects an empty patch after removing actor and precondition fields', async () => {
    const response = await invoke('PATCH', {
      body: {
        expectedUpdatedAt: ENTRY_UPDATED_AT,
        createdBy: SPOOFED_ACTOR_ID,
        updatedBy: SPOOFED_ACTOR_ID,
      },
    });

    expect(response.status).toBe(400);
    expect(mockMainDb.updates).toHaveLength(0);
  });

  it('returns 404 for an unknown entry without mutation or success audit', async () => {
    const response = await invoke('PATCH', {
      id: UNKNOWN_ENTRY_ID,
      body: { expectedUpdatedAt: ENTRY_UPDATED_AT, comment: 'Not found' },
    });

    expect(response.status).toBe(404);
    expect(mockMainDb.updates).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });
});

describe('DELETE /api/team/talent-reserve/[id]', () => {
  it('deletes only the matching version and audits without candidate PII', async () => {
    const deleteFilters = instrumentTalentDeleteFilters();
    const response = await invoke('DELETE');

    expect(response.status).toBe(204);
    expect(deleteFilters).toEqual(expect.arrayContaining([
      { column: 'id', value: ENTRY_ID },
      { column: 'updated_at', value: ENTRY_UPDATED_AT },
    ]));
    expect(mockMainDb.getRows('team_talent_reserve_entries'))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: ENTRY_ID })]));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.talent_reserve.delete.success',
      'Talent reserve entry deleted',
      expect.objectContaining({ entryId: ENTRY_ID }),
      expect.objectContaining({ userId: ALINA_ID }),
    );
    const serializedAudit = JSON.stringify(mockLogAudit.mock.calls);
    expect(serializedAudit).not.toContain('Мария Кандидатова');
    expect(serializedAudit).not.toContain('https://t.me/candidate');
  });

  it('requires expectedUpdatedAt before reading or deleting an entry', async () => {
    const response = await invoke('DELETE', { body: {} });
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body).toEqual(expect.objectContaining({ code: 'precondition_required' }));
    expect(talentSelects()).toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('returns 409 for a stale delete without deleting or auditing success', async () => {
    const before = mockMainDb.getRows('team_talent_reserve_entries');
    const response = await invoke('DELETE', {
      body: { expectedUpdatedAt: '2026-08-01T08:59:59.000Z' },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      code: 'talent_reserve_conflict',
      currentUpdatedAt: ENTRY_UPDATED_AT,
    }));
    expect(mockMainDb.getRows('team_talent_reserve_entries')).toEqual(before);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });

  it('returns 404 for an unknown entry without deletion or success audit', async () => {
    const response = await invoke('DELETE', {
      id: UNKNOWN_ENTRY_ID,
      body: { expectedUpdatedAt: ENTRY_UPDATED_AT },
    });

    expect(response.status).toBe(404);
    expect(mockMainDb.mutations).toHaveLength(0);
    expect(successAuditEvents()).toHaveLength(0);
  });
});
