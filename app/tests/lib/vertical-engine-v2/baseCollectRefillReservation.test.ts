/** @jest-environment node */

const mockAppendLeads = jest.fn();
const mockGetBlockedEmailSet = jest.fn();
const mockFilterBlockedLeads = jest.fn();
const mockInstantlyMaybeSingle = jest.fn();
const mockInstantlyFrom = jest.fn(() => ({
  select: jest.fn(() => ({
    eq: jest.fn(() => ({ maybeSingle: mockInstantlyMaybeSingle })),
  })),
}));

jest.mock('@/lib/clientLaunch/appendLeads', () => {
  class AppendLeadsPartialError extends Error {
    readonly partialResult: Record<string, unknown>;

    constructor(message: string, partialResult: Record<string, unknown>) {
      super(message);
      this.partialResult = partialResult;
    }
  }
  return {
    appendLeadsToClientCampaign: (...args: unknown[]) => mockAppendLeads(...args),
    AppendLeadsPartialError,
  };
});

jest.mock('@/lib/clientBlocklist/blockedContacts', () => ({
  getBlockedEmailSet: (...args: unknown[]) => mockGetBlockedEmailSet(...args),
  filterBlockedLeads: (...args: unknown[]) => mockFilterBlockedLeads(...args),
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: { from: (_table: unknown) => mockInstantlyFrom() },
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { AppendLeadsPartialError } from '@/lib/clientLaunch/appendLeads';
import {
  buildBaseExclusionKeysFromRows,
  VE_AUTO_COLLECT_COLUMNS,
  type VeCollectInfo,
  type VeUnifiedRow,
} from '@/lib/verticalEngineV2/stages/baseCollect';
import { runVeRefillAppend } from '@/lib/verticalEngineV2/stages/baseCollectRefill';
import type { VeJob } from '@/lib/verticalEngineV2/types';

function row(email: string): VeUnifiedRow {
  return Object.fromEntries(
    VE_AUTO_COLLECT_COLUMNS.map((column) => [column, column === 'email' ? email : '']),
  ) as VeUnifiedRow;
}

function job(): VeJob {
  return {
    id: 'job-refill',
    project_id: 'project-1',
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: 'base-refill', refill: true },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-09-01T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

function dbWithCap(
  dailyLeadsCap: number,
  reservationGrant = dailyLeadsCap,
  deliveryBound = false,
): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      ve_projects: [{
        id: 'project-1',
        portal_period_id: deliveryBound ? 'period-1' : null,
      }],
      ve_bases: [{
        id: 'base-refill',
        project_id: 'project-1',
        source: 'auto',
        status: 'collecting',
        updated_at: '2026-09-01T00:00:00Z',
        data: [],
      }],
      ve_templates: [{
        id: 'template-1',
        vertical_id: 'vertical-1',
        launch_info: {
          campaign_id: 'campaign-1',
          campaign_name: 'Campaign',
          campaign_url: '',
          leads_count: 0,
          preset_id: 'preset-1',
          created_at: '2026-09-01T00:00:00Z',
        },
        personalization_plan: null,
        created_at: '2026-09-01T00:00:00Z',
      }],
      ve_auto_pipeline_configs: [{
        id: 'config-1',
        project_id: 'project-1',
        daily_leads_cap: dailyLeadsCap,
      }],
      ve_auto_pipeline_runs: [],
    },
    rpcHandlers: {
      ve_reserve_refill_daily_budget: (params) => {
        const requested = Number(params.p_requested ?? 0);
        const granted = Math.max(0, Math.min(requested, reservationGrant));
        return {
          data: [{
            reservation_id: granted > 0 ? 'reservation-1' : null,
            granted,
            budget_date: '2026-09-01',
          }],
        };
      },
      ve_finalize_refill_daily_budget: () => ({ data: null }),
    },
  });
}

const stats: NonNullable<VeCollectInfo['stats']> = {
  tasks_total: 1,
  tasks_done: 1,
  tasks_failed: 0,
  rows_total: 3,
  excluded_existing_bases: 0,
  excluded_during_fetch: 0,
  finished_at: '2026-09-01T00:00:00Z',
};

async function run(db: MockSupabaseClient) {
  return runVeRefillAppend({
    ctx: { supabase: db as unknown as SupabaseClient },
    job: job(),
    base: { id: 'base-refill', project_id: 'project-1', vertical_id: 'vertical-1' },
    info: { refill: true, campaign_id: 'campaign-1' },
    stats,
    finalRows: [row('one@example.test'), row('two@example.test'), row('three@example.test')],
    finalColumns: [...VE_AUTO_COLLECT_COLUMNS],
    emailStatuses: ['ok', 'ok', 'ok'],
    usage: { tokensUsed: 0, costUsd: 0 },
  });
}

function reservedEmails(db: MockSupabaseClient): Set<string> {
  const stored = db.getRows('ve_bases')[0]?.data as Array<Record<string, unknown>>;
  return buildBaseExclusionKeysFromRows(stored).emails;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInstantlyMaybeSingle.mockResolvedValue({
    data: { client_user_id: 'owner-1' },
    error: null,
  });
  mockGetBlockedEmailSet.mockResolvedValue(new Set<string>());
  mockFilterBlockedLeads.mockImplementation((leads: unknown[]) => ({
    kept: leads,
    blockedCount: 0,
  }));
  mockAppendLeads.mockResolvedValue({
    accepted: 3,
    skipped: 0,
    acceptedIndexes: [0, 1, 2],
    attemptedIndexes: [0, 1, 2],
    identityComplete: true,
  });
});

describe('VE2 refill contact reservations', () => {
  it('blocks legacy direct append before budget or provider work for a delivery-bound project', async () => {
    const db = dbWithCap(3, 3, true);

    await expect(run(db)).resolves.toMatchObject({
      result: { refill: { status: 'failed', error: expect.stringContaining('шаг 5') } },
    });

    expect(mockAppendLeads).not.toHaveBeenCalled();
    expect(mockGetBlockedEmailSet).not.toHaveBeenCalled();
    expect(db.rpcCalls).toEqual([]);
  });

  it('does not reserve candidates when a pre-append safety check fails', async () => {
    const db = dbWithCap(3);
    mockGetBlockedEmailSet.mockRejectedValue(new Error('blocklist unavailable'));

    await expect(run(db)).resolves.toMatchObject({
      result: { refill: { status: 'failed' } },
    });

    expect(reservedEmails(db)).toEqual(new Set());
    expect(mockAppendLeads).not.toHaveBeenCalled();
  });

  it('does not reserve rows that were left unsent by the daily cap', async () => {
    const db = dbWithCap(1);
    mockAppendLeads.mockResolvedValue({
      accepted: 1,
      skipped: 0,
      acceptedIndexes: [0],
      attemptedIndexes: [0],
      identityComplete: true,
    });

    await run(db);

    expect(reservedEmails(db)).toEqual(new Set(['one@example.test']));
  });

  it('does not reserve rows removed by the client tariff inside append', async () => {
    const db = dbWithCap(3);
    mockAppendLeads.mockResolvedValue({
      accepted: 1,
      skipped: 0,
      acceptedIndexes: [0],
      attemptedIndexes: [0],
      identityComplete: true,
    });

    await run(db);

    expect(reservedEmails(db)).toEqual(new Set(['one@example.test']));
    expect(db.rpcCalls.at(-1)).toEqual({
      fn: 've_finalize_refill_daily_budget',
      params: {
        p_reservation_id: 'reservation-1',
        p_base_id: 'base-refill',
        p_consumed: 1,
      },
    });
  });

  it('uses the atomically granted project-day budget instead of a read-then-send calculation', async () => {
    const db = dbWithCap(3, 1);
    mockAppendLeads.mockResolvedValue({
      accepted: 1,
      skipped: 0,
      acceptedIndexes: [0],
      attemptedIndexes: [0],
      identityComplete: true,
    });

    await run(db);

    expect(mockAppendLeads).toHaveBeenCalledWith(expect.objectContaining({
      leads: [expect.objectContaining({ email: 'one@example.test' })],
    }));
    expect(db.rpcCalls[0]).toEqual({
      fn: 've_reserve_refill_daily_budget',
      params: {
        p_project_id: 'project-1',
        p_base_id: 'base-refill',
        p_requested: 3,
      },
    });
  });

  it('does not reserve rows when append fails before any provider attempt', async () => {
    const db = dbWithCap(3);
    mockAppendLeads.mockRejectedValue(new Error('subscription is inactive'));

    await expect(run(db)).resolves.toMatchObject({
      result: { refill: { status: 'failed' } },
    });

    expect(reservedEmails(db)).toEqual(new Set());
    expect(db.rpcCalls.at(-1)).toEqual({
      fn: 've_finalize_refill_daily_budget',
      params: {
        p_reservation_id: 'reservation-1',
        p_base_id: 'base-refill',
        p_consumed: 0,
      },
    });
  });

  it('reserves only the attempted batch when append fails ambiguously', async () => {
    const db = dbWithCap(2);
    mockAppendLeads.mockRejectedValue(new AppendLeadsPartialError('provider timeout', {
      accepted: 0,
      skipped: 0,
      acceptedIndexes: [],
      attemptedIndexes: [0, 1],
      identityComplete: true,
    }));

    await expect(run(db)).resolves.toMatchObject({
      result: { refill: { status: 'failed' } },
    });

    expect(reservedEmails(db)).toEqual(new Set([
      'one@example.test',
      'two@example.test',
    ]));
    expect(db.getRows('ve_auto_pipeline_runs').at(-1)).toMatchObject({
      status: 'failed',
      stats: { appended: 0, attempted: 2 },
    });
    expect(db.rpcCalls.at(-1)).toEqual({
      fn: 've_finalize_refill_daily_budget',
      params: {
        p_reservation_id: 'reservation-1',
        p_base_id: 'base-refill',
        p_consumed: 2,
      },
    });
  });
});
