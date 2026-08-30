/** @jest-environment node */

import {
  buildRuLaunchTimingRefreshItems,
  refreshRuLaunchPortfolioTiming,
  VeLaunchTimingRefreshError,
  type VeLaunchTimingRefreshCode,
} from '@/lib/verticalEngineV2/launchPortfolioTiming';
import { seasonalityInputHash } from '@/lib/verticalEngineV2/launchTemplate';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';

const ITEM_ID = '00000000-0000-4000-8000-000000000711';
const HYPOTHESIS_ID = '00000000-0000-4000-8000-000000000712';

const seasonalityEvidence = {
  claim: 'Закупки активны осенью.',
  source_url: 'https://research.example/autumn',
  quote: 'Основной цикл закупок приходится на сентябрь.',
};

const seasonality = {
  version: 1 as const,
  classification: 'seasonal' as const,
  confidence: 'high' as const,
  rationale: 'Подтверждён осенний цикл закупок.',
  windows: [{
    kind: 'peak' as const,
    label: 'Осенний цикл',
    start_mm_dd: '09-01',
    end_mm_dd: '09-30',
    lead_days: 10,
    evidence: [seasonalityEvidence],
  }],
  evidence: [seasonalityEvidence],
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    portfolio_id: 'ru',
    hypothesis_id: HYPOTHESIS_ID,
    status: 'queued',
    seasonality_input_hash: seasonalityInputHash({
      hypothesisId: HYPOTHESIS_ID,
      seasonality,
    }),
    seasonality_snapshot: seasonality,
    estimated_run_days: 14,
    ...overrides,
  };
}

describe('RU launch timing refresh payload', () => {
  it('keeps the immutable hash stable after JSONB reorders object keys', () => {
    const reordered = {
      evidence: seasonality.evidence.map((item) => ({
        quote: item.quote,
        source_url: item.source_url,
        claim: item.claim,
      })),
      windows: seasonality.windows.map((window) => ({
        lead_days: window.lead_days,
        end_mm_dd: window.end_mm_dd,
        start_mm_dd: window.start_mm_dd,
        label: window.label,
        kind: window.kind,
        evidence: window.evidence.map((item) => ({
          quote: item.quote,
          claim: item.claim,
          source_url: item.source_url,
        })),
      })),
      rationale: seasonality.rationale,
      confidence: seasonality.confidence,
      classification: seasonality.classification,
      version: seasonality.version,
    };

    expect(seasonalityInputHash({ hypothesisId: HYPOTHESIS_ID, seasonality: reordered }))
      .toBe(seasonalityInputHash({ hypothesisId: HYPOTHESIS_ID, seasonality }));
  });

  it('reads every RU queue page before issuing one atomic batch refresh', async () => {
    const rows = [1, 2, 3].map((suffix) => row({
      id: `00000000-0000-4000-8000-00000000071${suffix}`,
    }));
    const db = createMockSupabase({
      enforceQueryWindows: true,
      maxRowsPerQuery: 1,
      tables: { ve_launch_queue_items: rows },
      rpcHandlers: {
        ve_refresh_launch_seasonality_timing: async (args) => ({
          data: {
            refreshed: true,
            changed: true,
            plan_version: 8,
            refreshed_items: (args.p_items as unknown[]).length,
          },
        }),
      },
    });

    await expect(refreshRuLaunchPortfolioTiming({
      db: db as never,
      now: new Date('2026-08-25T09:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({
      refreshed: true,
      changed: true,
      plan_version: 8,
      refreshed_items: 3,
    }));
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]?.params.p_items).toHaveLength(3);
  });

  it('re-evaluates an immutable snapshot on the current Moscow date and derives start-by urgency', () => {
    expect(buildRuLaunchTimingRefreshItems(
      [row()],
      new Date('2026-08-25T09:00:00.000Z'),
    )).toEqual([{
      item_id: ITEM_ID,
      seasonality_input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      priority_snapshot: expect.objectContaining({
        state: 'launch_now',
        evaluated_on: '2026-08-25',
        seasonal_deadline_date: '2026-10-01',
        automatic_activation_eligible: true,
      }),
      latest_activation_at: '2026-09-17T00:00:00+03:00',
    }]);
  });

  it.each([
    ['invalid item id', { id: 'not-a-uuid' }, 'VE_LAUNCH_TIMING_ITEM_INVALID'],
    ['changed seasonality hash', { seasonality_input_hash: 'a'.repeat(64) }, 'VE_LAUNCH_TIMING_HASH_MISMATCH'],
    ['missing run estimate', { estimated_run_days: null }, 'VE_LAUNCH_TIMING_RUN_DAYS_INVALID'],
  ])('fails closed for %s', (_label, overrides, code) => {
    expect(() => buildRuLaunchTimingRefreshItems(
      [row(overrides)],
      new Date('2026-08-25T09:00:00.000Z'),
    )).toThrow(expect.objectContaining<Partial<VeLaunchTimingRefreshError>>({
      code: code as VeLaunchTimingRefreshCode,
    }));
  });
});
