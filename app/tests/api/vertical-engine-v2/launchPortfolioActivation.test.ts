/** @jest-environment node */

import type { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { seasonalityInputHash } from '@/lib/verticalEngineV2/launchTemplate';

const USER_ID = '00000000-0000-4000-8000-000000000381';
const ITEM_ID = '00000000-0000-4000-8000-000000000382';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000383';
const ACTIVATION_ID = '00000000-0000-4000-8000-000000000384';

let portalDb: MockSupabaseClient = createMockSupabase();
const mockActivateCampaign = jest.fn();
const mockGetCampaign = jest.fn();

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomUUID: jest.fn(() => '00000000-0000-4000-8000-000000000384'),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return portalDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: portalDb, userId: USER_ID, role: 'specialist' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/instantly/client', () => ({
  activateCampaign: (...args: unknown[]) => mockActivateCampaign(...args),
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
}));

import { POST } from '@/app/api/tools/vertical-engine-v2/launch-portfolio/[id]/activate/route';

const params = { params: Promise.resolve({ id: ITEM_ID }) };

function request(body: Record<string, unknown>): NextRequest {
  return new Request(
    `http://x/api/tools/vertical-engine-v2/launch-portfolio/${ITEM_ID}/activate`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function activationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confirm_campaign_review: true,
    idempotency_key: IDEMPOTENCY_KEY,
    plan_version: 1,
    ...overrides,
  };
}

function seedReserve(
  result: Record<string, unknown>,
  finalizeResult?: Record<string, unknown>,
) {
  const seasonality = {
    version: 1,
    classification: 'neutral',
    confidence: 'high',
    rationale: 'Круглогодичный спрос подтверждён.',
    windows: [],
    evidence: [{
      claim: 'Спрос идёт круглый год.',
      source_url: 'https://research.example/neutral',
      quote: 'Закупки проходят в течение всего года.',
    }],
  };
  portalDb = createMockSupabase({
    rpcHandlers: {
      ve_refresh_launch_seasonality_timing: async () => ({
        data: { refreshed: true, changed: false, plan_version: 1 },
      }),
      ve_reserve_launch_activation: async () => ({ data: result }),
      ve_reconcile_launch_campaign_statuses: async () => ({
        data: { reconciled: true },
      }),
      ve_finalize_launch_activation: async (args) => ({
        data: finalizeResult ?? {
          finalized: true,
          status: args.p_status,
          activation_reservation_id: args.p_activation_reservation_id,
        },
      }),
    },
    tables: {
      ve_launch_queue_items: [{
        id: ITEM_ID,
        portfolio_id: 'ru',
        hypothesis_id: null,
        instantly_account_id: 'workspace-ru-1',
        mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
        status: 'queued',
        seasonality_input_hash: seasonalityInputHash({ hypothesisId: null, seasonality }),
        seasonality_snapshot: seasonality,
        estimated_run_days: 14,
      }],
      ve_launch_queue_campaigns: [{
        id: 'queue-campaign-candidate',
        item_id: ITEM_ID,
        campaign_id: 'campaign-default',
      }, {
        id: 'queue-campaign-schools',
        item_id: ITEM_ID,
        campaign_id: 'campaign-schools',
      }],
      he_projects: [{ id: ITEM_ID, status: 'active' }],
      he_jobs: [{ id: ITEM_ID, status: 'running' }],
    },
  });
}

function reservedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reserved: true,
    replayed: false,
    activation_reservation_id: ACTIVATION_ID,
    item: {
      id: ITEM_ID,
      instantly_account_id: 'workspace-ru-1',
      mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
      status: 'activating',
    },
    campaigns: [
      { campaign_id: 'campaign-default', segment: null },
      { campaign_id: 'campaign-schools', segment: 'частные школы' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActivateCampaign.mockResolvedValue({ status: 1 });
  mockGetCampaign.mockImplementation(async (campaignId: string) => ({
    id: campaignId,
    status: 2,
    email_list: ['sender-a@example.test', 'sender-b@example.test'],
  }));
  seedReserve(reservedResult());
});

describe('POST /api/tools/vertical-engine-v2/launch-portfolio/[id]/activate', () => {
  it('requires an explicit review and an idempotency key before reserving a slot', async () => {
    const noReview = await POST(
      request(activationBody({ confirm_campaign_review: false })),
      params,
    );
    expect(noReview.status).toBe(409);
    expect(await noReview.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_REVIEW_REQUIRED' }),
    );

    const noKey = await POST(request(activationBody({ idempotency_key: '' })), params);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_IDEMPOTENCY_KEY_REQUIRED' }),
    );
    const noPlanVersion = await POST(
      request(activationBody({ plan_version: undefined })),
      params,
    );
    expect(noPlanVersion.status).toBe(409);
    expect(await noPlanVersion.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_PLAN_STALE' }),
    );
    expect(portalDb.rpcCalls).toHaveLength(0);
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ['VE_LAUNCH_HIGHER_PRIORITY_PENDING', 'Сначала запустите более приоритетную группу'],
    ['VE_LAUNCH_SLOT_OCCUPIED', 'Пул отправителей уже занят'],
    ['VE_LAUNCH_TIMING_BLOCKED', 'Сейчас неподходящее сезонное окно'],
  ])('returns %s before calling Instantly', async (code, message) => {
    seedReserve({ reserved: false, code, error: message });

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ code }));
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('reconciles a directly activated overlapping Instantly bundle before reserving capacity', async () => {
    const bypassItemId = '00000000-0000-4000-8000-000000000385';
    const seasonality = {
      version: 1,
      classification: 'neutral',
      confidence: 'high',
      rationale: 'Круглогодичный спрос подтверждён.',
      windows: [],
      evidence: [{
        claim: 'Спрос идёт круглый год.',
        source_url: 'https://research.example/neutral',
        quote: 'Закупки проходят в течение всего года.',
      }],
    };
    const seasonalityHash = seasonalityInputHash({ hypothesisId: null, seasonality });
    portalDb = createMockSupabase({
      rpcHandlers: {
        ve_refresh_launch_seasonality_timing: async () => ({
          data: { refreshed: true, changed: false, plan_version: 1 },
        }),
        ve_reconcile_launch_campaign_statuses: async (args, db) => {
          const observations = args.p_campaigns as Array<{ status: number }>;
          if (observations.some((observation) => observation.status === 1)) {
            await db
              .from('ve_launch_queue_items')
              .update({ status: 'active' })
              .eq('id', args.p_item_id);
          }
          return { data: { reconciled: true } };
        },
        ve_reserve_launch_activation: async (_args, db) => ({
          data: db.getRows('ve_launch_queue_items').some(
            (row) => row.id === bypassItemId && row.status === 'active',
          )
            ? { reserved: false, code: 'VE_LAUNCH_SLOT_OCCUPIED' }
            : reservedResult(),
        }),
        ve_finalize_launch_activation: async () => ({ data: { finalized: true } }),
      },
      tables: {
        ve_launch_queue_items: [{
          id: ITEM_ID,
          portfolio_id: 'ru',
          hypothesis_id: null,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'queued',
          seasonality_input_hash: seasonalityHash,
          seasonality_snapshot: seasonality,
          estimated_run_days: 14,
        }, {
          id: bypassItemId,
          portfolio_id: 'ru',
          hypothesis_id: null,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'queued',
          seasonality_input_hash: seasonalityHash,
          seasonality_snapshot: seasonality,
          estimated_run_days: 14,
        }],
        ve_launch_queue_campaigns: [{
          id: 'queue-campaign-candidate',
          item_id: ITEM_ID,
          campaign_id: 'campaign-default',
        }, {
          id: 'queue-campaign-bypass',
          item_id: bypassItemId,
          campaign_id: 'campaign-direct-bypass',
        }],
      },
    });
    mockGetCampaign.mockImplementation(async (campaignId: string) => ({
      id: campaignId,
      status: campaignId === 'campaign-direct-bypass' ? 1 : 2,
      email_list: ['sender-a@example.test'],
    }));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_SLOT_OCCUPIED' }),
    );
    expect(mockGetCampaign).toHaveBeenCalledWith(
      'campaign-direct-bypass',
      { accountId: 'workspace-ru-1' },
    );
    expect(portalDb.rpcCalls.map((call) => call.fn)).toEqual(
      expect.arrayContaining([
        've_refresh_launch_seasonality_timing',
        've_reconcile_launch_campaign_statuses',
        've_reserve_launch_activation',
      ]),
    );
    const refreshCall = portalDb.rpcCalls.find(
      (call) => call.fn === 've_refresh_launch_seasonality_timing',
    );
    expect(refreshCall?.params).toEqual(expect.objectContaining({
      p_portfolio_id: 'ru',
      p_items: expect.arrayContaining([
        expect.objectContaining({ item_id: ITEM_ID }),
        expect.objectContaining({ item_id: bypassItemId }),
      ]),
      p_now: expect.any(String),
    }));
    expect(portalDb.rpcCalls.findIndex((call) => call.fn === 've_refresh_launch_seasonality_timing'))
      .toBeLessThan(portalDb.rpcCalls.findIndex((call) => call.fn === 've_reserve_launch_activation'));
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('reconciles a manually released tracked bundle and restores its slot after direct reactivation', async () => {
    const releasedItemId = '00000000-0000-4000-8000-000000000386';
    const seasonality = {
      version: 1,
      classification: 'neutral',
      confidence: 'high',
      rationale: 'Круглогодичный спрос подтверждён.',
      windows: [],
      evidence: [{
        claim: 'Спрос идёт круглый год.',
        source_url: 'https://research.example/neutral',
        quote: 'Закупки проходят в течение всего года.',
      }],
    };
    portalDb = createMockSupabase({
      rpcHandlers: {
        ve_refresh_launch_seasonality_timing: async () => ({
          data: { refreshed: true, changed: false, plan_version: 1 },
        }),
        ve_reconcile_launch_campaign_statuses: async (args, db) => {
          const observations = args.p_campaigns as Array<{ status: number }>;
          if (observations.every((observation) => observation.status === 1)) {
            await db.from('ve_launch_queue_items').update({ status: 'active' }).eq('id', args.p_item_id);
          }
          return { data: { reconciled: true } };
        },
        ve_reserve_launch_activation: async (_args, db) => ({
          data: db.getRows('ve_launch_queue_items').some(
            (row) => row.id === releasedItemId && row.status === 'active',
          )
            ? { reserved: false, code: 'VE_LAUNCH_SLOT_OCCUPIED' }
            : reservedResult(),
        }),
      },
      tables: {
        ve_launch_queue_items: [{
          id: ITEM_ID,
          portfolio_id: 'ru',
          hypothesis_id: null,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'queued',
          seasonality_input_hash: seasonalityInputHash({ hypothesisId: null, seasonality }),
          seasonality_snapshot: seasonality,
          estimated_run_days: 14,
        }, {
          id: releasedItemId,
          portfolio_id: 'ru',
          hypothesis_id: null,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'released',
          released_by: USER_ID,
        }],
        ve_launch_queue_campaigns: [{
          id: 'queue-campaign-candidate',
          item_id: ITEM_ID,
          campaign_id: 'campaign-default',
        }, {
          id: 'queue-campaign-released',
          item_id: releasedItemId,
          campaign_id: 'campaign-released-reactivated',
        }],
      },
    });
    mockGetCampaign.mockImplementation(async (campaignId: string) => ({
      id: campaignId,
      status: campaignId === 'campaign-released-reactivated' ? 1 : 2,
      email_list: ['sender-a@example.test'],
    }));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_SLOT_OCCUPIED' }),
    );
    expect(mockGetCampaign).toHaveBeenCalledWith(
      'campaign-released-reactivated',
      { accountId: 'workspace-ru-1' },
    );
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('activates every segment campaign while the bundle owns one slot', async () => {
    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(200);
    expect(mockActivateCampaign).toHaveBeenCalledTimes(2);
    expect(mockActivateCampaign).toHaveBeenNthCalledWith(
      1,
      'campaign-default',
      { accountId: 'workspace-ru-1' },
    );
    expect(mockActivateCampaign).toHaveBeenNthCalledWith(
      2,
      'campaign-schools',
      { accountId: 'workspace-ru-1' },
    );
    expect(portalDb.rpcCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: 've_finalize_launch_activation',
          params: expect.objectContaining({
            p_item_id: ITEM_ID,
            p_activation_reservation_id: ACTIVATION_ID,
            p_status: 'active',
          }),
        }),
      ]),
    );
  });

  it('keeps the slot fail-closed when only part of a bundle activates', async () => {
    mockActivateCampaign
      .mockResolvedValueOnce({ status: 1 })
      .mockRejectedValueOnce(new Error('Instantly timeout'));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_ACTIVATION_UNCERTAIN' }),
    );
    expect(portalDb.rpcCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: 've_finalize_launch_activation',
          params: expect.objectContaining({ p_status: 'uncertain' }),
        }),
      ]),
    );
  });

  it('never reports success when the finalization RPC rejects the terminal state', async () => {
    seedReserve(reservedResult(), {
      finalized: false,
      replayed: false,
      code: 'VE_LAUNCH_CAS_LOST',
    });

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_ACTIVATION_UNCERTAIN' }),
    );
    expect(mockActivateCampaign).toHaveBeenCalledTimes(2);
  });

  it('replays an already finalized idempotency key without external calls', async () => {
    seedReserve({
      ...reservedResult(),
      reserved: false,
      replayed: true,
      item: { id: ITEM_ID, status: 'active' },
    });

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ replayed: true, status: 'active' }),
    );
    expect(mockActivateCampaign).not.toHaveBeenCalled();
    expect(portalDb.rpcCalls.filter((call) => call.fn === 've_finalize_launch_activation')).toHaveLength(0);
  });

  it.each([
    ['missing workspace', reservedResult({
      item: {
        id: ITEM_ID,
        instantly_account_id: '',
        mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
        status: 'activating',
      },
    })],
    ['partial campaign set', reservedResult({
      campaigns: [{ campaign_id: 'campaign-default', segment: null }],
    })],
    ['malformed campaign set', reservedResult({
      campaigns: [
        { campaign_id: 'campaign-default', segment: null },
        { campaign_id: '', segment: 'частные школы' },
      ],
    })],
    ['wrong reservation token', reservedResult({
      activation_reservation_id: '00000000-0000-4000-8000-000000000399',
    })],
    ['wrong reserved item', reservedResult({
      item: {
        id: '00000000-0000-4000-8000-000000000398',
        instantly_account_id: 'workspace-ru-1',
        mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
        status: 'activating',
      },
    })],
  ])('fails closed before external mutation for an inexact reservation payload: %s', async (_case, result) => {
    seedReserve(result);

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_ACTIVATION_UNCERTAIN' }),
    );
    expect(mockActivateCampaign).not.toHaveBeenCalled();
    expect(portalDb.rpcCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: 've_finalize_launch_activation',
          params: expect.objectContaining({ p_status: 'uncertain' }),
        }),
      ]),
    );
  });

  it('rejects an idempotency conflict even when the reservation RPC marks it replayed', async () => {
    seedReserve({
      reserved: false,
      replayed: true,
      code: 'VE_LAUNCH_IDEMPOTENCY_CONFLICT',
    });

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_IDEMPOTENCY_CONFLICT' }),
    );
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('fails closed when Instantly returns a different campaign identity', async () => {
    mockGetCampaign.mockImplementation(async (campaignId: string) => ({
      id: `${campaignId}-other`,
      status: 2,
      email_list: ['sender-a@example.test', 'sender-b@example.test'],
    }));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_RECONCILIATION_FAILED' }),
    );
    expect(portalDb.rpcCalls.some((call) => call.fn === 've_reserve_launch_activation')).toBe(false);
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it.each(['activating', 'uncertain'])('live-reconciles a %s replay and never reports silent success', async (status) => {
    seedReserve({
      ...reservedResult(),
      reserved: false,
      replayed: true,
      status,
      item: {
        id: ITEM_ID,
        instantly_account_id: 'workspace-ru-1',
        mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
        status,
      },
    });
    await portalDb.from('ve_launch_queue_items').update({ status }).eq('id', ITEM_ID);

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_ACTIVATION_UNCERTAIN' }),
    );
    expect(mockGetCampaign).toHaveBeenCalledTimes(4);
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['partial', ['sender-a@example.test']],
    ['different', ['sender-a@example.test', 'sender-c@example.test']],
    ['malformed', ['sender-a@example.test', 'sender-b@example.test', 42]],
  ])('blocks activation when a live campaign sender scope is %s', async (_case, emailList) => {
    mockGetCampaign.mockImplementation(async (campaignId: string) => ({
      id: campaignId,
      status: 2,
      email_list: emailList,
    }));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_RECONCILIATION_FAILED' }),
    );
    expect(portalDb.rpcCalls.some((call) => call.fn === 've_reserve_launch_activation')).toBe(false);
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('ignores overlapping terminal bundles when building the live reconciliation scope', async () => {
    const cancelledId = '00000000-0000-4000-8000-000000000386';
    seedReserve(reservedResult());
    portalDb = createMockSupabase({
      rpcHandlers: {
        ve_reserve_launch_activation: async () => ({ data: reservedResult() }),
        ve_reconcile_launch_campaign_statuses: async () => ({ data: { reconciled: true } }),
        ve_finalize_launch_activation: async () => ({ data: { finalized: true } }),
      },
      tables: {
        ve_launch_queue_items: [{
          id: ITEM_ID,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
          status: 'queued',
        }, {
          id: cancelledId,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'cancelled',
        }],
        ve_launch_queue_campaigns: [{
          id: 'queue-campaign-candidate-a',
          item_id: ITEM_ID,
          campaign_id: 'campaign-default',
        }, {
          id: 'queue-campaign-candidate-b',
          item_id: ITEM_ID,
          campaign_id: 'campaign-schools',
        }],
      },
    });

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(200);
    expect(mockGetCampaign).toHaveBeenCalledTimes(2);
    expect(mockActivateCampaign).toHaveBeenCalledTimes(2);
  });

  it('paginates every overlapping nonterminal bundle instead of truncating the scope at 100 rows', async () => {
    const blockerIds = Array.from({ length: 101 }, (_, index) =>
      `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
    );
    const blockerId = blockerIds.at(-1)!;
    portalDb = createMockSupabase({
      enforceQueryWindows: true,
      rpcHandlers: {
        ve_reconcile_launch_campaign_statuses: async (args, db) => {
          const observations = args.p_campaigns as Array<{ status: number }>;
          if (observations.some((observation) => observation.status === 1)) {
            await db.from('ve_launch_queue_items').update({ status: 'active' }).eq('id', args.p_item_id);
          }
          return { data: { reconciled: true } };
        },
        ve_reserve_launch_activation: async (_args, db) => ({
          data: db.getRows('ve_launch_queue_items').some(
            (row) => row.id === blockerId && row.status === 'active',
          )
            ? { reserved: false, code: 'VE_LAUNCH_SLOT_OCCUPIED' }
            : reservedResult(),
        }),
        ve_finalize_launch_activation: async () => ({ data: { finalized: true } }),
      },
      tables: {
        ve_launch_queue_items: [{
          id: ITEM_ID,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'queued',
        }, ...blockerIds.map((id) => ({
          id,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'queued',
        }))],
        ve_launch_queue_campaigns: [{
          id: 'queue-campaign-candidate',
          item_id: ITEM_ID,
          campaign_id: 'campaign-default',
        }, ...blockerIds.map((id, index) => ({
          id: `queue-campaign-${index}`,
          item_id: id,
          campaign_id: `campaign-${index}`,
        }))],
      },
    });
    mockGetCampaign.mockImplementation(async (campaignId: string) => ({
      id: campaignId,
      status: campaignId === 'campaign-100' ? 1 : 2,
      email_list: ['sender-a@example.test'],
    }));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_SLOT_OCCUPIED' }),
    );
    expect(mockGetCampaign).toHaveBeenCalledWith('campaign-100', { accountId: 'workspace-ru-1' });
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('paginates and verifies more than 500 tracked campaigns for one bundle', async () => {
    const campaignIds = Array.from({ length: 501 }, (_, index) => `campaign-${index}`);
    portalDb = createMockSupabase({
      enforceQueryWindows: true,
      rpcHandlers: {
        ve_reconcile_launch_campaign_statuses: async (args, db) => {
          const observations = args.p_campaigns as Array<{ status: number }>;
          if (observations.some((observation) => observation.status === 1)) {
            await db.from('ve_launch_queue_items').update({ status: 'active' }).eq('id', args.p_item_id);
          }
          return { data: { reconciled: true } };
        },
        ve_reserve_launch_activation: async (_args, db) => ({
          data: db.getRows('ve_launch_queue_items').some(
            (row) => row.id === ITEM_ID && row.status === 'active',
          )
            ? { reserved: false, code: 'VE_LAUNCH_NOT_QUEUED' }
            : reservedResult({ campaigns: campaignIds.map((campaign_id) => ({ campaign_id })) }),
        }),
        ve_finalize_launch_activation: async () => ({ data: { finalized: true } }),
      },
      tables: {
        ve_launch_queue_items: [{
          id: ITEM_ID,
          instantly_account_id: 'workspace-ru-1',
          mailbox_ids: ['sender-a@example.test'],
          status: 'queued',
        }],
        ve_launch_queue_campaigns: campaignIds.map((campaignId, index) => ({
          id: `queue-campaign-${String(index).padStart(4, '0')}`,
          item_id: ITEM_ID,
          campaign_id: campaignId,
        })),
      },
    });
    mockGetCampaign.mockImplementation(async (campaignId: string) => ({
      id: campaignId,
      status: campaignId === 'campaign-500' ? 1 : 2,
      email_list: ['sender-a@example.test'],
    }));

    const response = await POST(request(activationBody()), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'VE_LAUNCH_NOT_QUEUED' }),
    );
    expect(mockGetCampaign).toHaveBeenCalledWith('campaign-500', { accountId: 'workspace-ru-1' });
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });
});
