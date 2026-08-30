/** @jest-environment node */

import type { NextRequest } from 'next/server';
import {
  createMockSupabase,
  type MockSupabaseClient,
  type MockSupabaseSeed,
} from '@/../tests/helpers/mockSupabase';
import { CampaignStatus } from '@/lib/instantly/types';
import { seasonalityInputHash } from '@/lib/verticalEngineV2/launchTemplate';

const USER_ID = '00000000-0000-4000-8000-000000000581';
const ITEM_ID = '00000000-0000-4000-8000-000000000582';

function queueItemId(index: number): string {
  return index === 0
    ? ITEM_ID
    : `00000000-0000-4000-8000-${String(600 + index).padStart(12, '0')}`;
}

let portalDb: MockSupabaseClient = createMockSupabase();
const mockGetCampaign = jest.fn();

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
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
}));

import { GET } from '@/app/api/tools/vertical-engine-v2/launch-portfolio/route';
import { PATCH } from '@/app/api/tools/vertical-engine-v2/launch-portfolio/items/[id]/route';

const params = { params: Promise.resolve({ id: ITEM_ID }) };

function getRequest(): NextRequest {
  return new Request('http://x/api/tools/vertical-engine-v2/launch-portfolio?market=ru', {
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new Request(
    `http://x/api/tools/vertical-engine-v2/launch-portfolio/items/${ITEM_ID}`,
    {
      method: 'PATCH',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function seed(
  overrides: Partial<Record<string, unknown>> = {},
  rpcOverrides: MockSupabaseSeed['rpcHandlers'] = {},
  options: {
    queueItemCount?: number;
    queueItemOverrides?: Array<Partial<Record<string, unknown>>>;
    campaignCount?: number;
    enforceQueryWindows?: boolean;
    maxRowsPerQuery?: number;
  } = {},
) {
  const seasonality = {
    version: 1,
    classification: 'neutral',
    confidence: 'high',
    rationale: 'Круглогодичный спрос подтверждён.',
    windows: [],
    evidence: [{
      claim: 'Спрос распределён в течение года.',
      source_url: 'https://research.example/neutral',
      quote: 'Закупки проходят в течение всего года.',
    }],
  };
  const queueItem = {
    id: ITEM_ID,
    portfolio_id: 'ru',
    project_id: 'project-queue-1',
    vertical_id: 'vertical-queue-1',
    hypothesis_id: 'hypothesis-queue-1',
    base_id: 'base-queue-1',
    template_id: 'template-queue-1',
    instantly_account_id: 'workspace-a',
    mailbox_ids: ['sender@example.test'],
    status: 'queued',
    manual_order: null,
    not_before: null,
    latest_activation_at: '2026-09-01T00:00:00.000Z',
    seasonality_confidence: 'high',
    seasonality_input_hash: seasonalityInputHash({
      hypothesisId: 'hypothesis-queue-1',
      seasonality,
    }),
    potential_pct: 80,
    priority_snapshot: {
      state: 'launch_now',
      priority: 100,
      automatic_activation_eligible: true,
    },
    seasonality_snapshot: seasonality,
    estimated_run_days: 14,
    plan_version: 3,
    priority_override_decision: null,
    priority_override_reason: null,
    priority_overridden_by: null,
    priority_overridden_at: null,
    created_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
  const queueItems = Array.from({ length: options.queueItemCount ?? 1 }, (_, index) => ({
    ...queueItem,
    id: queueItemId(index),
    created_at: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index).toISOString(),
    ...(options.queueItemOverrides?.[index] ?? {}),
  }));

  portalDb = createMockSupabase({
    enforceQueryWindows: options.enforceQueryWindows,
    maxRowsPerQuery: options.maxRowsPerQuery,
    rpcHandlers: {
      ve_refresh_launch_seasonality_timing: async () => ({
        data: { refreshed: true, changed: false, plan_version: 3 },
      }),
      ve_override_launch_priority: async (args) => ({
        data: { overridden: true, item: { id: args.p_item_id } },
      }),
      ve_reconcile_launch_campaign_statuses: async () => ({
        data: { reconciled: true, status: 'active' },
      }),
      ve_manual_release_launch_slot: async () => ({
        data: { released: true, item: { id: ITEM_ID, status: 'released' } },
      }),
      ...rpcOverrides,
    },
    tables: {
      ve_launch_portfolio_settings: [
        {
          market: 'ru',
          max_active_bundles: 1,
          timezone: 'Europe/Moscow',
          mode: 'enforced',
          default_slot_days: 14,
          plan_version: 3,
        },
      ],
      ve_launch_queue_items: [
        ...queueItems,
      ],
      ve_launch_queue_campaigns: Array.from(
        { length: options.campaignCount ?? 1 },
        (_, index) => ({
          id: `queue-campaign-${String(index + 1).padStart(4, '0')}`,
          item_id: ITEM_ID,
          campaign_id: index === 0 ? 'campaign-default' : `campaign-${index + 1}`,
          campaign_name: index === 0 ? 'VBI · Частные школы' : `VBI · Сегмент ${index + 1}`,
          campaign_url:
            `https://app.instantly.ai/app/campaign/${index === 0 ? 'campaign-default' : `campaign-${index + 1}`}`,
          segment: 'Частные школы',
          leads_count: 100,
          remote_status: CampaignStatus.Paused,
          status_observed_at: '2026-08-28T12:00:00.000Z',
        }),
      ),
      ve_projects: [
        { id: 'project-queue-1', name: 'VBI', website_url: 'https://vbi.ru', market: 'ru' },
      ],
      ve_verticals: [{ id: 'vertical-queue-1', name: 'Частные школы' }],
      ve_hypotheses: [{ id: 'hypothesis-queue-1', title: 'Набор учеников' }],
      he_projects: [{ id: 'project-queue-1', name: 'Не читать' }],
    },
  });
}

type CampaignRangeResult = {
  data: Array<Record<string, unknown>>;
  error: { message: string } | null;
  count: number;
};

function interceptCampaignRanges(
  mutate: (result: CampaignRangeResult, call: number) => CampaignRangeResult,
) {
  const originalFrom = portalDb.from;
  let rangeCalls = 0;
  portalDb.from = ((table: string) => {
    const builder = originalFrom(table);
    if (table !== 've_launch_queue_campaigns') return builder;
    const originalRange = builder.range.bind(builder);
    builder.range = (...args: unknown[]) => originalRange(...args).then((result) => {
      rangeCalls += 1;
      return mutate(result, rangeCalls);
    });
    return builder;
  }) as MockSupabaseClient['from'];
}

function mockAllCampaignsPaused() {
  mockGetCampaign.mockImplementation(async (campaignId: string) => ({
    id: campaignId,
    status: CampaignStatus.Paused,
    email_list: ['sender@example.test'],
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCampaign.mockResolvedValue({
    id: 'campaign-default',
    status: CampaignStatus.Paused,
    email_list: ['sender@example.test'],
  });
  seed();
});

describe('GET /api/tools/vertical-engine-v2/launch-portfolio', () => {
  it('returns a v2-only ranked queue with campaign bundles and capacity context', async () => {
    const response = await GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      market: 'ru',
      as_of: expect.any(String),
      mode: 'enforced',
      plan_version: 3,
      capacity: expect.objectContaining({
        max_active_bundles: 1,
        occupied_bundles: 0,
        active_bundles: 0,
        next_estimated_release_at: null,
      }),
      items: [expect.objectContaining({
        id: ITEM_ID,
        project_name: 'VBI',
        vertical_name: 'Частные школы',
        hypothesis_title: 'Набор учеников',
        status: 'queued',
        activation_admissible: true,
        is_activation_head: true,
        activation_head_id: ITEM_ID,
        capacity: {
          max_active_bundles: 1,
          occupied_bundles: 0,
          slot_available: true,
          blocking_bundle_ids: [],
        },
        seasonality: expect.objectContaining({ classification: 'neutral' }),
        campaigns: [expect.objectContaining({
          campaign_id: 'campaign-default',
          campaign_name: 'VBI · Частные школы',
          campaign_url: 'https://app.instantly.ai/app/campaign/campaign-default',
          segment: 'Частные школы',
          leads_count: 100,
        })],
      })],
    }));
    expect(portalDb.selects.some((select) => select.table.startsWith('he_'))).toBe(false);
    expect(portalDb.selects).toContainEqual(expect.objectContaining({
      table: 've_launch_queue_campaigns',
      columns: expect.stringContaining('campaign_name, campaign_url'),
    }));
    expect(portalDb.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fn: 've_refresh_launch_seasonality_timing',
        params: expect.objectContaining({
          p_portfolio_id: 'ru',
          p_items: [expect.objectContaining({
            item_id: ITEM_ID,
            seasonality_input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            priority_snapshot: expect.objectContaining({
              state: 'neutral',
              automatic_activation_eligible: true,
            }),
            latest_activation_at: null,
          })],
          p_now: expect.any(String),
        }),
      }),
    ]));
  });

  it('marks authoritative activation heads only among admissible overlapping candidates', async () => {
    seed({}, {}, {
      queueItemCount: 6,
      queueItemOverrides: [
        {
          manual_order: 0,
          priority_override_decision: 'wait',
          priority_override_reason: 'ЛПР в отпуске',
          priority_overridden_by: USER_ID,
          priority_overridden_at: '2026-08-28T10:00:00.000Z',
        },
        {
          manual_order: 1,
          not_before: '2099-01-01T00:00:00.000Z',
        },
        {
          manual_order: 2,
          priority_snapshot: {
            state: 'wait',
            priority: 500,
            automatic_activation_eligible: false,
          },
        },
        {
          manual_order: 3,
          priority_snapshot: {
            state: 'avoid',
            priority: 600,
            automatic_activation_eligible: false,
          },
          priority_override_decision: 'activate_next',
          priority_override_reason: 'Клиент подтвердил окно',
          priority_overridden_by: USER_ID,
          priority_overridden_at: '2026-08-28T11:00:00.000Z',
        },
        { manual_order: 4 },
        {
          manual_order: 5,
          mailbox_ids: ['disjoint@example.test'],
        },
      ],
    });

    const response = await GET(getRequest());
    const payload = await response.json();
    const byItemId = new Map(
      payload.items.map((item: Record<string, unknown>) => [item.id, item]),
    );
    const ids = Array.from({ length: 6 }, (_, index) => queueItemId(index));

    expect(response.status).toBe(200);
    for (const index of [0, 1, 2]) {
      expect(byItemId.get(ids[index])).toEqual(expect.objectContaining({
        activation_admissible: false,
        is_activation_head: false,
        activation_head_id: null,
      }));
    }
    expect(byItemId.get(ids[3])).toEqual(expect.objectContaining({
      activation_admissible: true,
      is_activation_head: true,
      activation_head_id: ids[3],
    }));
    expect(byItemId.get(ids[4])).toEqual(expect.objectContaining({
      activation_admissible: true,
      is_activation_head: false,
      activation_head_id: ids[3],
    }));
    expect(byItemId.get(ids[5])).toEqual(expect.objectContaining({
      activation_admissible: true,
      is_activation_head: true,
      activation_head_id: ids[5],
    }));
  });

  it('returns the complete queue when it exceeds one PostgREST page', async () => {
    seed({}, {}, { queueItemCount: 501, enforceQueryWindows: true });

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.items).toHaveLength(501);
    expect(portalDb.selects.filter((select) => select.table === 've_launch_queue_items').length)
      .toBeGreaterThan(2);
    expect(portalDb.selects.filter((select) => select.table === 've_launch_queue_campaigns'))
      .toHaveLength(3);
  });

  it('returns every child campaign when one bundle exceeds the PostgREST row cap', async () => {
    seed({}, {}, {
      campaignCount: 1001,
      enforceQueryWindows: true,
      maxRowsPerQuery: 1000,
    });

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].campaigns).toHaveLength(1001);
    expect(payload.items[0].campaigns.at(-1)).toEqual(expect.objectContaining({
      campaign_id: 'campaign-1001',
    }));
    expect(portalDb.selects.filter((select) => select.table === 've_launch_queue_campaigns').length)
      .toBeGreaterThan(1);
  });
});

describe('PATCH /api/tools/vertical-engine-v2/launch-portfolio/items/[id]', () => {
  it.each(['override_seasonality', 'release'])(
    'requires an audit reason for %s',
    async (action) => {
      const response = await PATCH(patchRequest({ action, reason: '   ' }), params);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ code: 'VE_LAUNCH_REASON_REQUIRED' }));
      expect(portalDb.rpcCalls).toHaveLength(0);
    },
  );

  it('persists a manual seasonal override without bypassing the sending slot', async () => {
    const response = await PATCH(
      patchRequest({
        action: 'override_seasonality',
        decision: 'activate_next',
        reason: 'Клиент подтвердил бюджетное окно',
        manual_order: 0,
        not_before: '2026-08-29',
      }),
      params,
    );

    expect(response.status).toBe(200);
    expect(portalDb.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fn: 've_override_launch_priority',
        params: expect.objectContaining({
          p_item_id: ITEM_ID,
          p_actor_id: USER_ID,
          p_reason: 'Клиент подтвердил бюджетное окно',
          p_decision: 'activate_next',
          p_manual_order: 0,
        }),
      }),
    ]));
  });

  it.each([undefined, '', 'launch_now'])(
    'requires an explicit activate_next or wait override decision (%p)',
    async (decision) => {
      const response = await PATCH(
        patchRequest({
          action: 'override_seasonality',
          decision,
          reason: 'Клиент подтвердил окно',
        }),
        params,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({
        code: 'VE_LAUNCH_DECISION_INVALID',
      }));
      expect(portalDb.rpcCalls).toHaveLength(0);
    },
  );

  it('does not report a rejected priority override as success', async () => {
    seed({}, {
      ve_override_launch_priority: async () => ({
        data: { overridden: false, code: 'VE_LAUNCH_OVERRIDE_STATE_CONFLICT' },
      }),
    });

    const response = await PATCH(
      patchRequest({
        action: 'override_seasonality',
        decision: 'wait',
        reason: 'Окно уже закрыто',
      }),
      params,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'VE_LAUNCH_OVERRIDE_STATE_CONFLICT',
    }));
  });

  it('refuses manual release while live Instantly status is active', async () => {
    seed({ status: 'active' });
    mockGetCampaign.mockResolvedValue({
      id: 'campaign-default',
      status: CampaignStatus.Active,
      email_list: ['sender@example.test'],
    });

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Хотим перейти к следующей кампании' }),
      params,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ code: 'VE_LAUNCH_CAMPAIGN_STILL_ACTIVE' }));
    expect(portalDb.rpcCalls.filter((call) => call.fn === 've_manual_release_launch_slot')).toHaveLength(0);
  });

  it(
    'reconciles fresh statuses and releases a non-sending active bundle with a reason',
    async () => {
      seed({ status: 'active' });
      mockGetCampaign.mockResolvedValue({
        id: 'campaign-default',
        status: CampaignStatus.Paused,
        email_list: ['sender@example.test'],
      });

      const response = await PATCH(
        patchRequest({ action: 'release', reason: 'Кампания остановлена и закрыта специалистом' }),
        params,
      );

      expect(response.status).toBe(200);
      expect(mockGetCampaign).toHaveBeenCalledWith('campaign-default', { accountId: 'workspace-a' });
      expect(portalDb.rpcCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ fn: 've_reconcile_launch_campaign_statuses' }),
        expect.objectContaining({
          fn: 've_manual_release_launch_slot',
          params: expect.objectContaining({
            p_item_id: ITEM_ID,
            p_actor_id: USER_ID,
            p_reason: 'Кампания остановлена и закрыта специалистом',
          }),
        }),
      ]));
    },
  );

  it('reads and reconciles every child campaign beyond the PostgREST 1000-row cap', async () => {
    seed(
      { status: 'active' },
      {},
      { campaignCount: 1001, enforceQueryWindows: true, maxRowsPerQuery: 1000 },
    );
    mockAllCampaignsPaused();

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Все кампании завершены' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mockGetCampaign).toHaveBeenCalledTimes(1001);
    expect(mockGetCampaign).toHaveBeenLastCalledWith('campaign-1001', {
      accountId: 'workspace-a',
    });
    expect(portalDb.rpcCalls.find(
      (call) => call.fn === 've_reconcile_launch_campaign_statuses',
    )?.params.p_campaigns).toHaveLength(1001);
    expect(portalDb.selects.filter(
      (select) => select.table === 've_launch_queue_campaigns',
    ).length).toBeGreaterThan(1);
  });

  it('fails closed when the exact child count changes between pages', async () => {
    seed(
      { status: 'active' },
      {},
      { campaignCount: 201, enforceQueryWindows: true },
    );
    mockAllCampaignsPaused();
    interceptCampaignRanges((result, call) => (
      call === 2 ? { ...result, count: result.count + 1 } : result
    ));

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Все кампании завершены' }),
      params,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'VE_LAUNCH_CAMPAIGNS_READ_FAILED',
    }));
    expect(mockGetCampaign).not.toHaveBeenCalled();
    expect(portalDb.rpcCalls.filter(
      (call) => call.fn === 've_reconcile_launch_campaign_statuses'
        || call.fn === 've_manual_release_launch_slot',
    )).toHaveLength(0);
  });

  it('fails closed when exact child pagination ends before the advertised count', async () => {
    seed(
      { status: 'active' },
      {},
      { campaignCount: 201, enforceQueryWindows: true },
    );
    mockAllCampaignsPaused();
    interceptCampaignRanges((result, call) => (
      call === 2 ? { ...result, data: [] } : result
    ));

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Все кампании завершены' }),
      params,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'VE_LAUNCH_CAMPAIGNS_READ_FAILED',
    }));
    expect(mockGetCampaign).not.toHaveBeenCalled();
    expect(portalDb.rpcCalls.filter(
      (call) => call.fn === 've_reconcile_launch_campaign_statuses'
        || call.fn === 've_manual_release_launch_slot',
    )).toHaveLength(0);
  });

  it('never releases a bundle while its external activation request may still be running', async () => {
    seed({ status: 'activating' });

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Кажется, кампания ещё на паузе' }),
      params,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'VE_LAUNCH_ACTIVATION_IN_PROGRESS',
    }));
    expect(mockGetCampaign).not.toHaveBeenCalled();
    expect(portalDb.rpcCalls.filter((call) => call.fn === 've_manual_release_launch_slot'))
      .toHaveLength(0);
  });

  it('does not report a rejected manual release as success', async () => {
    seed({ status: 'active' }, {
      ve_manual_release_launch_slot: async () => ({
        data: { released: false, code: 'LIVE_PROOF_STALE' },
      }),
    });
    mockGetCampaign.mockResolvedValue({
      id: 'campaign-default',
      status: CampaignStatus.Paused,
      email_list: ['sender@example.test'],
    });

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Проверили остановку' }),
      params,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ code: 'LIVE_PROOF_STALE' }));
  });

  it('keeps the slot when a live campaign mailbox scope differs from the immutable bundle', async () => {
    seed({ status: 'active' });
    mockGetCampaign.mockResolvedValue({
      id: 'campaign-default',
      status: CampaignStatus.Paused,
      email_list: ['different@example.test'],
    });

    const response = await PATCH(
      patchRequest({ action: 'release', reason: 'Проверили остановку' }),
      params,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'VE_LAUNCH_MAILBOX_SCOPE_MISMATCH',
    }));
    expect(portalDb.rpcCalls.filter((call) => call.fn === 've_reconcile_launch_campaign_statuses'))
      .toHaveLength(0);
  });
});
