/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { campaignOwnershipRpcHandlers } from '@/../tests/helpers/mockCampaignOwnershipRpc';
import { mockTransitionProjectPeriod } from '@/../tests/helpers/mockProjectPeriodTransitionRpc';
import type { NextRequest } from 'next/server';

let mockMainDb: MockSupabaseClient | null = null;
let mockInstantlyDb: MockSupabaseClient | null = null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

function makePeriodReq(body: unknown): NextRequest {
  return new Request('http://x/api/projects/project-1/periods', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('POST /api/projects/[id]/periods', () => {
  beforeEach(() => {
    jest.resetModules();
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: mockTransitionProjectPeriod,
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            contacts_done_synced_at: '2026-05-19T12:00:00.000Z',
            kpi_plan: '20',
            kpi_fact: '3',
            deadline: '2026-05-04',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            budget: '100000',
            margin: '30%',
            payment_method: 'bank',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        instantly_campaign_catalog: [],
      },
    });
  });

  it('stores old commercial terms in the closed period and new terms in the active period', async () => {
    const { POST } = await import('@/app/api/projects/[id]/periods/route');

    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        contacts_obligation: '12000',
        kpi_plan: '30',
        deadline: '2026-06-20',
        budget: '150000',
        margin: '40%',
        payment_date: '2026-05-21',
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockMainDb!.rpcCalls.map((call) => call.fn)).toEqual([
      'transition_project_period',
    ]);

    const periods = mockMainDb!.getRows('project_periods');
    expect(periods).toHaveLength(2);
    expect(periods[0]).toEqual(
      expect.objectContaining({
        name: 'Period 1',
        status: 'closed',
        period_start: '2026-03-27',
        period_end: '2026-05-19',
        contacts_obligation: '8000-16000',
        contacts_done: '182',
        kpi_plan: '20',
        kpi_fact: '3',
        deadline: '2026-05-04',
        budget: '100000',
        margin: '30%',
        payment_date: '2026-03-27',
      }),
    );
    expect(periods[0]).not.toHaveProperty('payment_method');
    expect(periods[1]).toEqual(
      expect.objectContaining({
        name: 'Period 2',
        status: 'active',
        period_start: '2026-05-20',
        period_end: null,
        contacts_obligation: '12000',
        contacts_done: '0',
        kpi_plan: '30',
        kpi_fact: '0',
        deadline: '2026-06-20',
        budget: '150000',
        margin: '40%',
        payment_date: '2026-05-21',
      }),
    );
    expect(periods[1]).not.toHaveProperty('payment_method');

    const project = mockMainDb!.getRows('projects')[0];
    expect(project).toEqual(
      expect.objectContaining({
        contacts_obligation: '12000',
        contacts_done: '0',
        contacts_done_synced_at: null,
        kpi_plan: '30',
        kpi_fact: '0',
        deadline: '2026-06-20',
        budget: '150000',
        margin: '40%',
        payment_method: 'bank',
        payment_date: '2026-05-21',
      }),
    );
  });

  it('rejects a period_start earlier than the preceding period start (no backwards range)', async () => {
    const { POST } = await import('@/app/api/projects/[id]/periods/route');

    // launch_date = 2026-03-27 → Period 1 стартовал бы 03-27. Старт 03-20
    // раньше — у Period 1 получился бы period_end < period_start. Отклоняем.
    const res = await POST(
      makePeriodReq({ period_start: '2026-03-20', contacts_obligation: '12000' }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(400);
    // Ничего не записали: ни периодов, ни сброса проекта.
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(0);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '182' }),
    );
  });

  it('rejects a foreign campaign owner before creating or closing any periods', async () => {
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          {
            id: 'campaign-foreign',
            timestamp_created: '2026-05-01T00:00:00Z',
            new_leads_contacted_count: 100,
          },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          {
            id: 'foreign-period-link',
            project_id: 'project-foreign',
            period_id: 'foreign-period',
            campaign_id: 'campaign-foreign',
            match_source: 'manual',
          },
        ],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-foreign'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(409);
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(0);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '182', kpi_fact: '3' }),
    );
  });

  it('fails closed before reservation when carried-campaign baseline read fails', async () => {
    mockInstantlyDb = createMockSupabase({
      errorSelects: {
        instantly_campaign_catalog: {
          columnsInclude: 'id, new_leads_contacted_count',
          message: 'campaign baseline unavailable',
        },
      },
      rpcHandlers: campaignOwnershipRpcHandlers,
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 37 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(500);
    expect(mockInstantlyDb!.rpcCalls.map((call) => call.fn)).toEqual([
      'check_project_instantly_campaign_ownership',
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(0);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '182', kpi_fact: '3' }),
    );
  });

  it('leaves no main-period or campaign-link subset when the second reservation item fails', async () => {
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        reserve_project_period_instantly_campaigns: async () => ({
          data: null,
          error: { message: 'second reservation item failed; transaction rolled back' },
        }),
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
          { id: 'campaign-2', new_leads_contacted_count: 20 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1', 'campaign-2'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(500);
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '182', kpi_fact: '3' }),
    );
  });

  it('replays an ambiguous reservation RPC with the same IDs before advancing the period', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    let reservationAttempts = 0;
    const reserveCampaigns = jest.fn(async (params, db) => {
      reservationAttempts += 1;
      const committed = await campaignOwnershipRpcHandlers.reserve_project_period_instantly_campaigns(
        params,
        db,
      );
      if (reservationAttempts === 1) {
        return {
          data: null,
          error: { message: 'network failed after reservation commit' },
        };
      }
      return committed;
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        reserve_project_period_instantly_campaigns: reserveCampaigns,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(200);
    expect(reserveCampaigns).toHaveBeenCalledTimes(2);
    expect(reserveCampaigns.mock.calls[1]?.[0]).toEqual(reserveCampaigns.mock.calls[0]?.[0]);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-1', campaign_id: 'campaign-1' }),
    ]);
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(2);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '0', kpi_fact: '0' }),
    );
  });

  it('keeps a committed reservation when both reservation responses are ambiguous', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    const reserveCampaigns = jest.fn(async (params, db) => {
      await campaignOwnershipRpcHandlers.reserve_project_period_instantly_campaigns(params, db);
      return {
        data: null,
        error: { message: 'reservation response lost' },
      };
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        reserve_project_period_instantly_campaigns: reserveCampaigns,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(500);
    expect(reserveCampaigns).toHaveBeenCalledTimes(2);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-1', campaign_id: 'campaign-1' }),
    ]);
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(0);
  });

  it('releases reservations only after a definitive main RPC rollback', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: async () => ({
          data: null,
          error: {
            message: 'new period insert failed; transaction rolled back',
            code: 'XX000',
          },
        }),
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            contacts_done_synced_at: '2026-05-19T12:00:00.000Z',
            kpi_plan: '20',
            kpi_fact: '3',
            deadline: '2026-05-04',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            budget: '100000',
            margin: '30%',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(500);
    expect(releaseReservations).toHaveBeenCalledTimes(1);
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'active', period_end: null }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '182', kpi_fact: '3' }),
    );
  });

  it('fences a concurrent period change instead of creating a second renewal', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: async (params, db) => {
          // Another committed transition changed the period set after the
          // route read its snapshot but before this RPC obtained the lock.
          await db.from('project_periods').insert({
            id: 'period-concurrent',
            project_id: 'project-1',
            name: 'Concurrent closed period',
            status: 'closed',
            period_start: '2026-05-01',
            period_end: '2026-05-10',
          });
          return mockTransitionProjectPeriod(params, db);
        },
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            kpi_plan: '20',
            kpi_fact: '3',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(409);
    expect(mockMainDb!.rpcCalls[0]).toEqual(expect.objectContaining({
      fn: 'transition_project_period',
      params: expect.objectContaining({
        p_expected_period_count: 1,
        p_expected_active_period_id: 'period-active',
      }),
    }));
    expect(releaseReservations).toHaveBeenCalledTimes(1);
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'active' }),
      expect.objectContaining({ id: 'period-concurrent', status: 'closed' }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toHaveLength(0);
  });

  it('replays an ambiguous main RPC as a barrier before releasing reservations', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    let transitionAttempts = 0;
    let lateCommit: Promise<void> | null = null;
    const transitionPeriod = jest.fn(async (params, db) => {
      transitionAttempts += 1;
      if (transitionAttempts === 1) {
        lateCommit = new Promise<void>((resolve) => {
          setTimeout(() => {
            void mockTransitionProjectPeriod(params, db).then(() => resolve());
          }, 5);
        });
        return {
          data: null,
          error: { message: 'network failed while main transaction was still running' },
        };
      }
      await lateCommit;
      return mockTransitionProjectPeriod(params, db);
    });
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: transitionPeriod,
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            kpi_plan: '20',
            kpi_fact: '3',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );
    await lateCommit;

    expect(res.status).toBe(200);
    expect(transitionPeriod).toHaveBeenCalledTimes(2);
    expect(transitionPeriod.mock.calls[1]?.[0]).toEqual(transitionPeriod.mock.calls[0]?.[0]);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'closed' }),
      expect.objectContaining({ status: 'active', period_start: '2026-05-20' }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-1', campaign_id: 'campaign-1' }),
    ]);
  });

  it('keeps reservations when the retry times out before it can fence a late main commit', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    let transitionAttempts = 0;
    let lateCommit: Promise<void> | null = null;
    const transitionPeriod = jest.fn(async (params, db) => {
      transitionAttempts += 1;
      if (transitionAttempts === 1) {
        lateCommit = new Promise<void>((resolve) => {
          setTimeout(() => {
            void mockTransitionProjectPeriod(params, db).then(() => resolve());
          }, 10);
        });
        return {
          data: null,
          error: { message: 'first response lost while transaction kept running' },
        };
      }
      return {
        data: null,
        error: { message: 'timed out waiting for an available connection', code: 'PGRST003' },
      };
    });
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: transitionPeriod,
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            kpi_plan: '20',
            kpi_fact: '3',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );
    await lateCommit;

    expect(res.status).toBe(500);
    expect(transitionPeriod).toHaveBeenCalledTimes(2);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'closed' }),
      expect.objectContaining({ status: 'active', period_start: '2026-05-20' }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-1', campaign_id: 'campaign-1' }),
    ]);
  });

  it('keeps reservations after two ambiguous main RPC responses and an empty read-back', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    const transitionPeriod = jest.fn(async () => ({
      data: null,
      error: { message: 'main RPC response lost' },
    }));
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: transitionPeriod,
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            kpi_plan: '20',
            kpi_fact: '3',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(500);
    expect(transitionPeriod).toHaveBeenCalledTimes(2);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'active' }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-1', campaign_id: 'campaign-1' }),
    ]);
  });

  it('returns the committed period on an ambiguous RPC response without releasing reservations', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    mockMainDb = createMockSupabase({
      rpcHandlers: {
        transition_project_period: async (params, db) => {
          await mockTransitionProjectPeriod(params, db);
          return {
            data: null,
            error: { message: 'network failed after main transaction commit' },
          };
        },
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            kpi_plan: '20',
            kpi_fact: '3',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(200);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'closed', period_end: '2026-05-19' }),
      expect.objectContaining({ status: 'active', period_start: '2026-05-20' }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({
        project_id: 'project-1',
        campaign_id: 'campaign-1',
      }),
    ]);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '0', kpi_fact: '0' }),
    );
  });

  it('keeps reservations when read-back fails and main commit state is unknown', async () => {
    const releaseReservations = jest.fn(
      campaignOwnershipRpcHandlers.release_project_period_campaign_reservations,
    );
    mockMainDb = createMockSupabase({
      errorSelects: {
        project_periods: {
          columnsInclude: 'id, project_id, name',
          message: 'read-back unavailable',
        },
      },
      rpcHandlers: {
        transition_project_period: async () => ({
          data: null,
          error: { message: 'main RPC response lost' },
        }),
      },
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            kpi_plan: '20',
            kpi_fact: '3',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [
          {
            id: 'period-active',
            project_id: 'project-1',
            name: 'Period 1',
            status: 'active',
            period_start: '2026-04-01',
            period_end: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    mockInstantlyDb = createMockSupabase({
      rpcHandlers: {
        ...campaignOwnershipRpcHandlers,
        release_project_period_campaign_reservations: releaseReservations,
      },
      tables: {
        instantly_campaign_catalog: [
          { id: 'campaign-1', new_leads_contacted_count: 10 },
        ],
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
      },
    });

    const { POST } = await import('@/app/api/projects/[id]/periods/route');
    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        carry_campaign_ids: ['campaign-1'],
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(500);
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(mockMainDb!.getRows('project_periods')).toEqual([
      expect.objectContaining({ id: 'period-active', status: 'active', period_end: null }),
    ]);
    expect(mockInstantlyDb!.getRows('project_period_instantly_campaigns')).toEqual([
      expect.objectContaining({ project_id: 'project-1', campaign_id: 'campaign-1' }),
    ]);
  });
});
