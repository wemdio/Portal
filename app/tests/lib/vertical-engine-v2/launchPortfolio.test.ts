/** @jest-environment node */

/**
 * Red-phase contract for the v2-only launch portfolio domain.
 *
 * A "bundle" is one business launch unit even when segmentation materializes
 * several Instantly campaigns. Capacity belongs to the immutable Instantly
 * workspace + mailbox snapshot, not to research jobs or individual campaigns.
 */

import { CampaignStatus } from '@/lib/instantly/types';
import {
  evaluateLaunchActivationHeads,
  evaluateLaunchBundleRelease,
  evaluateLaunchCapacity,
  launchMailboxScopesEqual,
  latestSeasonalActivationAt,
  rankLaunchQueue,
  validateManualLaunchRelease,
} from '@/lib/verticalEngineV2/launchPortfolio';

type PortfolioCampaign = {
  campaign_id: string;
  status: number | null;
  status_observed_at: string | null;
};

type PortfolioBundle = {
  id: string;
  instantly_account_id: string;
  mailbox_ids: string[];
  status: 'prepared' | 'queued' | 'activating' | 'active' | 'uncertain' | 'released';
  campaigns: PortfolioCampaign[];
  ever_active_at: string | null;
  manual_order: number | null;
  latest_activation_at: string | null;
  seasonality_confidence: 'low' | 'medium' | 'high' | null;
  potential_pct: number;
  created_at: string;
};

type ActivationQueueItem = PortfolioBundle & {
  not_before: string | null;
  priority_snapshot: { automatic_activation_eligible?: boolean };
  priority_override_decision: 'activate_next' | 'wait' | null;
  priority_override_reason: string | null;
  priority_overridden_by: string | null;
  priority_overridden_at: string | null;
};

const NOW = '2026-08-28T12:00:00.000Z';

describe('immutable mailbox scope', () => {
  it('compares normalized mailbox sets exactly', () => {
    expect(launchMailboxScopesEqual(
      [' Sender-B@example.test ', 'sender-a@example.test', 'sender-a@example.test'],
      ['sender-a@example.test', 'sender-b@example.test'],
    )).toBe(true);
    expect(launchMailboxScopesEqual(
      ['sender-a@example.test'],
      ['sender-a@example.test', 'sender-b@example.test'],
    )).toBe(false);
    expect(launchMailboxScopesEqual([], [])).toBe(false);
  });
});

function campaign(
  id: string,
  status: number | null = CampaignStatus.Paused,
  observedAt: string | null = '2026-08-28T11:59:00.000Z',
): PortfolioCampaign {
  return {
    campaign_id: id,
    status,
    status_observed_at: observedAt,
  };
}

function bundle(overrides: Partial<PortfolioBundle> = {}): PortfolioBundle {
  return {
    id: 'bundle-1',
    instantly_account_id: 'workspace-a',
    mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
    status: 'queued',
    campaigns: [campaign('campaign-1')],
    ever_active_at: null,
    manual_order: null,
    latest_activation_at: '2026-09-10T00:00:00.000Z',
    seasonality_confidence: 'medium',
    potential_pct: 50,
    created_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function activationQueueItem(
  overrides: Partial<ActivationQueueItem> & Pick<ActivationQueueItem, 'id'>,
): ActivationQueueItem {
  return {
    ...bundle({ id: overrides.id }),
    not_before: null,
    priority_snapshot: { automatic_activation_eligible: true },
    priority_override_decision: null,
    priority_override_reason: null,
    priority_overridden_by: null,
    priority_overridden_at: null,
    ...overrides,
  };
}

describe('launch bundle capacity', () => {
  it('counts one segmented launch bundle with N campaigns as one capacity unit', () => {
    const candidate = bundle({
      campaigns: [
        campaign('campaign-default'),
        campaign('campaign-schools'),
        campaign('campaign-clinics'),
      ],
    });

    expect(
      evaluateLaunchCapacity({
        candidate,
        holders: [],
        max_active_bundles: 1,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: true,
        required_slots: 1,
        occupied_slots: 0,
        blocking_bundle_ids: [],
      }),
    );
  });

  it('blocks capacity=1 only for overlapping mailboxes in the same Instantly workspace', () => {
    const active = bundle({
      id: 'active-a',
      status: 'active',
      ever_active_at: '2026-08-27T08:00:00.000Z',
      mailbox_ids: ['sender-a@example.test', 'sender-b@example.test'],
      campaigns: [campaign('campaign-active', CampaignStatus.Active)],
    });

    const overlapping = evaluateLaunchCapacity({
      candidate: bundle({ id: 'overlap', mailbox_ids: ['sender-b@example.test'] }),
      holders: [active],
      max_active_bundles: 1,
    });
    expect(overlapping).toEqual(
      expect.objectContaining({
        allowed: false,
        occupied_slots: 1,
        blocking_bundle_ids: ['active-a'],
      }),
    );

    const disjoint = evaluateLaunchCapacity({
      candidate: bundle({ id: 'disjoint', mailbox_ids: ['sender-c@example.test'] }),
      holders: [active],
      max_active_bundles: 1,
    });
    expect(disjoint).toEqual(
      expect.objectContaining({ allowed: true, occupied_slots: 0, blocking_bundle_ids: [] }),
    );

    const otherWorkspace = evaluateLaunchCapacity({
      candidate: bundle({
        id: 'other-workspace',
        instantly_account_id: 'workspace-b',
        mailbox_ids: ['sender-a@example.test'],
      }),
      holders: [active],
      max_active_bundles: 1,
    });
    expect(otherWorkspace).toEqual(
      expect.objectContaining({ allowed: true, occupied_slots: 0, blocking_bundle_ids: [] }),
    );
  });

  it('keeps an uncertain activation in the slot and never preempts a holder', () => {
    const uncertain = bundle({
      id: 'uncertain-holder',
      status: 'uncertain',
      ever_active_at: '2026-08-28T09:00:00.000Z',
      mailbox_ids: ['shared@example.test'],
      campaigns: [campaign('campaign-unknown', null, null)],
      manual_order: 999,
    });
    const manuallyPinnedCandidate = bundle({
      id: 'pinned-candidate',
      mailbox_ids: ['shared@example.test'],
      manual_order: 0,
      latest_activation_at: '2026-08-29T00:00:00.000Z',
      potential_pct: 95,
    });

    expect(
      evaluateLaunchCapacity({
        candidate: manuallyPinnedCandidate,
        holders: [uncertain],
        max_active_bundles: 1,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        blocking_bundle_ids: ['uncertain-holder'],
        preempted_bundle_ids: [],
      }),
    );
  });
});

describe('deterministic queue ordering', () => {
  const ids = (rows: PortfolioBundle[]) => rankLaunchQueue(rows, { as_of: NOW }).map((row) => row.id);

  it('applies manual order before seasonal urgency', () => {
    expect(
      ids([
        bundle({ id: 'urgent', latest_activation_at: '2026-08-29T00:00:00.000Z' }),
        bundle({
          id: 'manual',
          manual_order: 0,
          latest_activation_at: '2026-10-01T00:00:00.000Z',
        }),
      ]),
    ).toEqual(['manual', 'urgent']);
  });

  it('orders by the start-by deadline derived from peak completion and run duration', () => {
    const shortRunLatest = latestSeasonalActivationAt({
      seasonal_deadline_date: '2026-09-11',
      estimated_run_days: 2,
    });
    const longRunLatest = latestSeasonalActivationAt({
      seasonal_deadline_date: '2026-10-01',
      estimated_run_days: 30,
    });

    expect(shortRunLatest).toBe('2026-09-09T00:00:00+03:00');
    expect(longRunLatest).toBe('2026-09-01T00:00:00+03:00');
    expect(ids([
      bundle({ id: 'short-later-slack', latest_activation_at: shortRunLatest }),
      bundle({ id: 'long-less-slack', latest_activation_at: longRunLatest }),
    ])).toEqual(['long-less-slack', 'short-later-slack']);
  });

  it('does not invent a seasonal deadline when no positive peak exists', () => {
    expect(latestSeasonalActivationAt({
      seasonal_deadline_date: null,
      estimated_run_days: 30,
    })).toBeNull();
  });

  it('then orders by urgency, confidence, potential, starvation age and stable id', () => {
    const common = {
      manual_order: null,
      latest_activation_at: '2026-09-10T00:00:00.000Z',
      seasonality_confidence: 'medium' as const,
      potential_pct: 50,
      created_at: '2026-08-20T00:00:00.000Z',
    };

    expect(
      ids([
        bundle({ ...common, id: 'later', latest_activation_at: '2026-09-11T00:00:00.000Z' }),
        bundle({ ...common, id: 'sooner', latest_activation_at: '2026-09-09T00:00:00.000Z' }),
      ]),
    ).toEqual(['sooner', 'later']);

    expect(
      ids([
        bundle({ ...common, id: 'low-confidence', seasonality_confidence: 'low' }),
        bundle({ ...common, id: 'high-confidence', seasonality_confidence: 'high' }),
      ]),
    ).toEqual(['high-confidence', 'low-confidence']);

    expect(
      ids([
        bundle({ ...common, id: 'lower-potential', potential_pct: 40 }),
        bundle({ ...common, id: 'higher-potential', potential_pct: 80 }),
      ]),
    ).toEqual(['higher-potential', 'lower-potential']);

    expect(
      ids([
        bundle({ ...common, id: 'newer', created_at: '2026-08-25T00:00:00.000Z' }),
        bundle({ ...common, id: 'older', created_at: '2026-08-01T00:00:00.000Z' }),
      ]),
    ).toEqual(['older', 'newer']);

    const equalA = bundle({ ...common, id: 'bundle-a' });
    const equalB = bundle({ ...common, id: 'bundle-b' });
    expect(ids([equalB, equalA])).toEqual(['bundle-a', 'bundle-b']);
    expect(ids([equalA, equalB])).toEqual(['bundle-a', 'bundle-b']);
  });
});

describe('authoritative activation heads', () => {
  it('marks one admissible head per overlapping mailbox scope in enforced mode', () => {
    const rows = [
      activationQueueItem({
        id: 'audited-wait',
        manual_order: 0,
        mailbox_ids: ['shared@example.test'],
        priority_override_decision: 'wait',
        priority_override_reason: 'ЛПР в отпуске',
        priority_overridden_by: 'user-1',
        priority_overridden_at: '2026-08-28T10:00:00.000Z',
      }),
      activationQueueItem({
        id: 'future-start',
        manual_order: 1,
        mailbox_ids: ['shared@example.test'],
        not_before: '2026-08-29T12:00:00.000Z',
      }),
      activationQueueItem({
        id: 'seasonally-ineligible',
        manual_order: 2,
        mailbox_ids: ['shared@example.test'],
        priority_snapshot: { automatic_activation_eligible: false },
      }),
      activationQueueItem({
        id: 'audited-override-head',
        manual_order: 3,
        mailbox_ids: ['shared@example.test'],
        priority_snapshot: { automatic_activation_eligible: false },
        priority_override_decision: 'activate_next',
        priority_override_reason: 'Клиент подтвердил текущее окно',
        priority_overridden_by: 'user-2',
        priority_overridden_at: '2026-08-28T11:00:00.000Z',
      }),
      activationQueueItem({
        id: 'overlapping-lower-priority',
        manual_order: 4,
        mailbox_ids: ['shared@example.test', 'second@example.test'],
      }),
      activationQueueItem({
        id: 'disjoint-head',
        manual_order: 5,
        mailbox_ids: ['disjoint@example.test'],
      }),
      activationQueueItem({
        id: 'prepared-not-candidate',
        manual_order: -1,
        status: 'prepared',
        mailbox_ids: ['shared@example.test'],
      }),
    ];

    const { marks } = evaluateLaunchActivationHeads(rows, {
      as_of: NOW,
      mode: 'enforced',
    });

    for (const excludedId of [
      'audited-wait',
      'future-start',
      'seasonally-ineligible',
      'prepared-not-candidate',
    ]) {
      expect(marks.get(excludedId)).toEqual({
        activation_admissible: false,
        is_activation_head: false,
        activation_head_id: null,
      });
    }
    expect(marks.get('audited-override-head')).toEqual({
      activation_admissible: true,
      is_activation_head: true,
      activation_head_id: 'audited-override-head',
    });
    expect(marks.get('overlapping-lower-priority')).toEqual({
      activation_admissible: true,
      is_activation_head: false,
      activation_head_id: 'audited-override-head',
    });
    expect(marks.get('disjoint-head')).toEqual({
      activation_admissible: true,
      is_activation_head: true,
      activation_head_id: 'disjoint-head',
    });
  });

  it('admits seasonally ineligible rows in advisory mode but still excludes audited wait', () => {
    const rows = [
      activationQueueItem({
        id: 'advisory-head',
        manual_order: 0,
        mailbox_ids: ['shared@example.test'],
        priority_snapshot: { automatic_activation_eligible: false },
      }),
      activationQueueItem({
        id: 'advisory-wait',
        manual_order: -1,
        mailbox_ids: ['shared@example.test'],
        priority_snapshot: { automatic_activation_eligible: false },
        priority_override_decision: 'wait',
        priority_override_reason: 'Ручное ожидание',
        priority_overridden_by: 'user-3',
        priority_overridden_at: '2026-08-28T11:00:00.000Z',
      }),
    ];

    const { marks } = evaluateLaunchActivationHeads(rows, {
      as_of: NOW,
      mode: 'advisory',
    });

    expect(marks.get('advisory-head')).toEqual({
      activation_admissible: true,
      is_activation_head: true,
      activation_head_id: 'advisory-head',
    });
    expect(marks.get('advisory-wait')).toEqual({
      activation_admissible: false,
      is_activation_head: false,
      activation_head_id: null,
    });
  });
});

describe('slot release', () => {
  const releaseOptions = {
    now: NOW,
    max_observation_age_ms: 5 * 60_000,
  };
  const nonTerminalCases: Array<[string, number | null, string | null]> = [
    ['Paused', CampaignStatus.Paused, '2026-08-28T11:59:00.000Z'],
    ['AccountsUnhealthy', CampaignStatus.AccountsUnhealthy, '2026-08-28T11:59:00.000Z'],
    ['missing status', null, null],
  ];

  it('auto-releases only after every campaign in the bundle is observed Completed', () => {
    const completed = bundle({
      status: 'active',
      ever_active_at: '2026-08-27T08:00:00.000Z',
      campaigns: [
        campaign('campaign-default', CampaignStatus.Completed),
        campaign('campaign-segment', CampaignStatus.Completed),
      ],
    });

    expect(evaluateLaunchBundleRelease(completed, releaseOptions)).toEqual(
      expect.objectContaining({
        auto_release: true,
        holds_slot: false,
        next_status: 'released',
      }),
    );
  });

  it.each(nonTerminalCases)('does not auto-release for %s', (_label, remoteStatus, observedAt) => {
    const result = evaluateLaunchBundleRelease(
      bundle({
        status: 'active',
        ever_active_at: '2026-08-27T08:00:00.000Z',
        campaigns: [campaign('campaign-1', remoteStatus, observedAt)],
      }),
      releaseOptions,
    );

    expect(result).toEqual(
      expect.objectContaining({
        auto_release: false,
        holds_slot: true,
      }),
    );
  });

  it('requires a reason and fresh live proof that no campaign is actively sending for manual release', () => {
    const paused = bundle({
      status: 'active',
      ever_active_at: '2026-08-27T08:00:00.000Z',
      campaigns: [campaign('campaign-1', CampaignStatus.Paused)],
    });

    expect(
      validateManualLaunchRelease({ bundle: paused, reason: '   ', ...releaseOptions }),
    ).toEqual(expect.objectContaining({ ok: false, code: 'REASON_REQUIRED' }));

    expect(
      validateManualLaunchRelease({
        bundle: bundle({
          status: 'active',
          ever_active_at: '2026-08-27T08:00:00.000Z',
          campaigns: [campaign('campaign-1', CampaignStatus.Active)],
        }),
        reason: 'Закрываем запуск',
        ...releaseOptions,
      }),
    ).toEqual(expect.objectContaining({ ok: false, code: 'CAMPAIGN_STILL_ACTIVE' }));

    expect(
      validateManualLaunchRelease({
        bundle: bundle({
          status: 'active',
          ever_active_at: '2026-08-27T08:00:00.000Z',
          campaigns: [campaign('campaign-1', CampaignStatus.RunningSubsequences)],
        }),
        reason: 'Закрываем запуск',
        ...releaseOptions,
      }),
    ).toEqual(expect.objectContaining({ ok: false, code: 'CAMPAIGN_STILL_ACTIVE' }));

    expect(
      validateManualLaunchRelease({
        bundle: bundle({
          status: 'active',
          ever_active_at: '2026-08-27T08:00:00.000Z',
          campaigns: [campaign('campaign-1', null, null)],
        }),
        reason: 'Закрываем запуск',
        ...releaseOptions,
      }),
    ).toEqual(expect.objectContaining({ ok: false, code: 'LIVE_PROOF_REQUIRED' }));

    expect(
      validateManualLaunchRelease({
        bundle: bundle({
          status: 'active',
          ever_active_at: '2026-08-27T08:00:00.000Z',
          campaigns: [
            campaign('campaign-1', CampaignStatus.Paused, '2026-08-28T11:40:00.000Z'),
          ],
        }),
        reason: 'Кампания остановлена специалистом',
        ...releaseOptions,
      }),
    ).toEqual(expect.objectContaining({ ok: false, code: 'LIVE_PROOF_STALE' }));

    expect(
      validateManualLaunchRelease({
        bundle: paused,
        reason: 'Кампания остановлена и больше не будет возобновлена',
        ...releaseOptions,
      }),
    ).toEqual(expect.objectContaining({ ok: true, code: 'OK' }));
  });
});
