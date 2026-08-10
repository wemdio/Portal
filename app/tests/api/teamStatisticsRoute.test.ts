/** @jest-environment node */

import type { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockMainDb: MockSupabaseClient | null = null;
const ALINA_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const SERGEY_ID = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
const OTHER_LEAD_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_DIRECTOR_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-000000000003';
const STAFF_ID = '00000000-0000-4000-8000-000000000004';
const CLIENT_ID = '00000000-0000-4000-8000-000000000005';
const DEMO_ID = '00000000-0000-4000-8000-000000000006';
const PRIVATE_TEAM_USERS = new Set([ALINA_ID, SERGEY_ID]);

let mockCurrentUser: { id: string } | null = { id: SERGEY_ID };
const mockGetUser = jest.fn();
const mockIsLeadershipUser = jest.fn();
const mockTeamAccessCapability = jest.fn(async (_functionName: string) => ({
  data: Boolean(mockCurrentUser && PRIVATE_TEAM_USERS.has(mockCurrentUser.id)),
  error: null as { message: string } | null,
}));

jest.mock('@/lib/auth/internalGuard', () => ({
  isInternalUser: () => {
    throw new Error('Team statistics must use isLeadershipUser');
  },
  isLeadershipUser: (...args: unknown[]) => mockIsLeadershipUser(...args),
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: jest.requireActual('@/lib/supabaseRouteClient').getBearerToken,
  createAuthedSupabaseClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: (functionName: string) => mockTeamAccessCapability(functionName),
  })),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

function makeReq(query: string, auth = 'Bearer test-token'): NextRequest {
  return new Request(`http://x/api/team/statistics?${query}`, {
    headers: { authorization: auth },
  }) as unknown as NextRequest;
}

function setCurrentUser(userId: string | null) {
  mockCurrentUser = userId ? { id: userId } : null;
  mockGetUser.mockResolvedValue({ data: { user: mockCurrentUser }, error: null });
}

describe('GET /api/team/statistics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
    jest.resetModules();
    mockCurrentUser = { id: SERGEY_ID };
    mockGetUser.mockReset();
    mockIsLeadershipUser.mockReset();
    mockIsLeadershipUser.mockImplementation(
      async (_client: unknown, userId: string) => PRIVATE_TEAM_USERS.has(userId),
    );
    mockTeamAccessCapability.mockClear();
    mockTeamAccessCapability.mockImplementation(async (_functionName: string) => ({
      data: Boolean(mockCurrentUser && PRIVATE_TEAM_USERS.has(mockCurrentUser.id)),
      error: null,
    }));
    mockGetUser.mockResolvedValue({
      data: { user: mockCurrentUser },
      error: null,
    });
    mockMainDb = createMockSupabase({
      tables: {
        team_project_history: [
          {
            id: 'history-1',
            project_id: 'project-1',
            period_id: 'period-1',
            project_name: 'Аутрич',
            client: 'Acme',
            project_status: 'Завершен',
            period_status: 'closed',
            manager: 'Лид А',
            specialist: 'Специалист А',
            specialist_user_id: 'specialist-a',
            kpi_plan: '10',
            kpi_fact: '12',
            launch_date: '2026-07-01',
            deadline: '2026-07-20',
            period_start: '2026-07-01',
            period_end: '2026-07-20',
            capture_source: 'initial',
            captured_at: '2026-07-29T00:00:00.000Z',
          },
        ],
        profiles: [
          {
            id: 'lead-a',
            email: 'lead.a@example.com',
            full_name: 'Лид А',
          },
          {
            id: 'specialist-a',
            email: 'spec.a@example.com',
            full_name: 'Специалист А',
          },
        ],
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the canonical partial-month contract and separates the coverage probe from the full history read', async () => {
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(200);
    expect(mockTeamAccessCapability).toHaveBeenCalledWith('can_access_team');
    expect(mockIsLeadershipUser).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({
      period: {
        kind: 'month',
        start: '2026-07-01',
        end: '2026-07-31',
        label: 'Июль 2026',
        previousAnchor: '2026-06-01',
        nextAnchor: null,
      },
      coverage: {
        status: 'partial',
        startsAt: '2026-07-29',
        asOf: '2026-07-29',
        periodComplete: false,
        message: 'История собирается с 29.07.2026; день запуска и более ранние данные неполные',
      },
      summary: {
        projects: 1,
        kpiMet: 1,
        kpiMissed: 0,
        inProgress: 0,
        unclassified: 0,
        leads: 12,
      },
      groups: {
        leads: [expect.objectContaining({ id: 'lead-a', name: 'Лид А', projects: 1 })],
        specialists: [
          expect.objectContaining({ id: 'specialist-a', name: 'Специалист А', projects: 1 }),
        ],
      },
    });

    expect(
      mockMainDb!.selects
        .filter((call) => call.table === 'team_project_history')
        .map((call) => call.columns),
    ).toEqual([
      'captured_at',
      'id, project_id, period_id, project_name, client, project_status, period_status, manager, specialist, specialist_user_id, kpi_plan, kpi_fact, launch_date, deadline, period_start, period_end, capture_source, captured_at',
    ]);
  });

  it('keeps a first snapshot from 00:00 Moscow even when its UTC date is the previous day', async () => {
    jest.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    const historyRows = mockMainDb!.getRows('team_project_history');
    const profileRows = mockMainDb!.getRows('profiles');
    mockMainDb = createMockSupabase({
      tables: {
        team_project_history: [{ ...historyRows[0], captured_at: '2026-07-29T21:00:00.000Z' }],
        profiles: profileRows,
      },
    });

    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-07-30'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        coverage: expect.objectContaining({ status: 'partial', startsAt: '2026-07-30' }),
        summary: expect.objectContaining({ projects: 1 }),
      }),
    );
  });
  it('returns an explicit empty unavailable response without pretending old zeroes are data', async () => {
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-06-15'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        coverage: expect.objectContaining({
          status: 'unavailable',
          message: 'История за этот период не собиралась',
        }),
        summary: {
          projects: 0,
          kpiMet: 0,
          kpiMissed: 0,
          inProgress: 0,
          unclassified: 0,
          leads: 0,
        },
        groups: { leads: [], specialists: [] },
      }),
    );
    expect(mockMainDb!.selects.filter((call) => call.table === 'team_project_history')).toEqual([
      { table: 'team_project_history', columns: 'captured_at' },
    ]);
  });

  it('returns a clear empty state when history has not started accumulating', async () => {
    mockMainDb = createMockSupabase({ tables: { team_project_history: [], profiles: [] } });
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        coverage: {
          status: 'unavailable',
          startsAt: null,
          asOf: '2026-07-29',
          periodComplete: false,
          message: 'История пока не накоплена',
        },
        summary: {
          projects: 0,
          kpiMet: 0,
          kpiMissed: 0,
          inProgress: 0,
          unclassified: 0,
          leads: 0,
        },
      }),
    );
    expect(mockMainDb!.selects).toEqual([
      { table: 'team_project_history', columns: 'captured_at' },
    ]);
  });
  it('loads a KPI baseline older than the previous calendar day for the partial month', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        team_project_history: [{
          id: 'long-history',
          project_id: 'long-project',
          period_id: 'long-period',
          project_name: 'Аутрич',
          client: 'Long',
          project_status: 'В работе',
          period_status: 'active',
          manager: 'Лид А',
          specialist: 'Специалист А',
          specialist_user_id: 'specialist-a',
          kpi_plan: '100',
          kpi_fact: '50',
          launch_date: '2026-06-01',
          deadline: null,
          period_start: '2026-06-01',
          period_end: null,
          capture_source: 'initial',
          captured_at: '2026-07-29T00:00:00.000Z',
        }],
        project_contacts_history: [
          { project_id: 'long-project', period_id: 'long-period', kpi_fact: 40, recorded_at: '2026-06-28' },
          { project_id: 'long-project', period_id: 'long-period', kpi_fact: 50, recorded_at: '2026-07-29' },
        ],
        profiles: [],
      },
    });
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(200);
    expect((await res.json()).summary.leads).toBe(10);
  });
  it('includes a July cycle that was closed just after the calendar boundary', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        team_project_history: [
          {
            id: 'active-at-end', project_id: 'late-close', period_id: 'july-cycle',
            project_name: 'Аутрич', client: 'Late close', project_status: 'В работе',
            period_status: 'active', manager: 'Лид А', specialist: 'Специалист А',
            specialist_user_id: 'specialist-a', kpi_plan: '10', kpi_fact: '9',
            launch_date: '2026-07-01', deadline: null, period_start: '2026-07-01',
            period_end: null, capture_source: 'period_trigger', captured_at: '2026-07-31T20:00:00.000Z',
          },
          {
            id: 'closed-next-day', project_id: 'late-close', period_id: 'july-cycle',
            project_name: 'Аутрич', client: 'Late close', project_status: 'В работе',
            period_status: 'closed', manager: 'Лид А', specialist: 'Специалист А',
            specialist_user_id: 'specialist-a', kpi_plan: '10', kpi_fact: '10',
            launch_date: '2026-07-01', deadline: '2026-07-31', period_start: '2026-07-01',
            period_end: '2026-07-31', capture_source: 'period_trigger', captured_at: '2026-08-01T08:00:00.000Z',
          },
        ],
        project_contacts_history: [],
        profiles: [],
      },
    });
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(200);
    expect((await res.json()).summary).toEqual(expect.objectContaining({ projects: 1, kpiMet: 1, inProgress: 0 }));
  });

  it.each([
    ['period=rolling&anchor=2026-07-29'],
    ['period=month&anchor=2026-02-30'],
    ['period=month'],
  ])('rejects invalid query: %s', async (query) => {
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq(query));

    expect(res.status).toBe(400);
  });

  it('requires a valid bearer-authenticated user', async () => {
    const { GET } = await import('@/app/api/team/statistics/route');
    expect((await GET(makeReq('period=month&anchor=2026-07-29', ''))).status).toBe(401);

    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'bad token' } });
    expect((await GET(makeReq('period=month&anchor=2026-07-29'))).status).toBe(401);
  });

  it.each([ALINA_ID, SERGEY_ID])(
    'allows an explicitly approved private-Team user %s',
    async (userId) => {
      setCurrentUser(userId);
      const { GET } = await import('@/app/api/team/statistics/route');

      const res = await GET(makeReq('period=month&anchor=2026-07-29'));

      expect(res.status).toBe(200);
      expect(mockTeamAccessCapability).toHaveBeenCalledWith('can_access_team');
      expect(mockIsLeadershipUser).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['lead', OTHER_LEAD_ID],
    ['director', OTHER_DIRECTOR_ID],
    ['admin', OTHER_ADMIN_ID],
    ['staff', STAFF_ID],
    ['client', CLIENT_ID],
    ['demo', DEMO_ID],
  ])('denies an unapproved %s before the admin history read', async (_label, userId) => {
    setCurrentUser(userId);
    const { GET } = await import('@/app/api/team/statistics/route');

    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(403);
    expect(mockTeamAccessCapability).toHaveBeenCalledWith('can_access_team');
    expect(mockMainDb!.selects).toHaveLength(0);
  });

  it('fails closed before the admin history read when the capability RPC fails', async () => {
    mockTeamAccessCapability.mockResolvedValueOnce({
      data: null,
      error: { message: 'private Team capability unavailable' },
    });
    const { GET } = await import('@/app/api/team/statistics/route');

    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(500);
    expect(mockMainDb!.selects).toHaveLength(0);
  });

  it('surfaces database failures instead of returning misleading empty statistics', async () => {
    mockMainDb = createMockSupabase({
      tables: { team_project_history: mockMainDb!.getRows('team_project_history') },
      errorTables: { profiles: 'profiles unavailable' },
    });
    const { GET } = await import('@/app/api/team/statistics/route');
    const res = await GET(makeReq('period=month&anchor=2026-07-29'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'profiles unavailable' });
  });
});
