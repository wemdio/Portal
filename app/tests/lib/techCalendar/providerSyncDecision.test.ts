import {
  isDueKeptProviderCycle,
  mergeProviderSubscriptionDecision,
} from '@/lib/techCalendar/providerSyncDecision';

const existing = {
  status: 'keep' as const,
  next_billing_date: '2026-09-10',
  decision_by: 'admin-1',
  decision_at: '2026-09-01T10:00:00.000Z',
  decision_notes: 'Продлеваем',
};

describe('provider subscription decision merge', () => {
  it('uses provider state for a new synced service', () => {
    expect(mergeProviderSubscriptionDecision(undefined, {
      status: 'active',
      next_billing_date: '2026-10-10',
    })).toEqual({
      status: 'active',
      next_billing_date: '2026-10-10',
      decision_by: null,
      decision_at: null,
      decision_notes: null,
    });
  });

  it.each(['keep', 'cancel'] as const)(
    'preserves the manual %s decision and its billing cycle during provider sync',
    (status) => {
      expect(mergeProviderSubscriptionDecision({ ...existing, status }, {
        status: 'active',
        next_billing_date: '2026-10-10',
      })).toEqual({ ...existing, status });
    },
  );

  it('lets provider data refresh an undecided service', () => {
    expect(mergeProviderSubscriptionDecision({
      ...existing,
      status: 'pending_review',
    }, {
      status: 'cancel',
      next_billing_date: '2026-09-05',
    })).toEqual({
      status: 'cancel',
      next_billing_date: '2026-09-05',
      decision_by: null,
      decision_at: null,
      decision_notes: null,
    });
  });

  it('lets provider data reactivate an automatically expired service', () => {
    expect(mergeProviderSubscriptionDecision({
      status: 'cancel',
      next_billing_date: '2026-09-05',
      decision_by: null,
      decision_at: null,
      decision_notes: null,
    }, {
      status: 'active',
      next_billing_date: '2026-10-05',
    })).toEqual({
      status: 'active',
      next_billing_date: '2026-10-05',
      decision_by: null,
      decision_at: null,
      decision_notes: null,
    });
  });

  it('locks an accepted cycle once its billing date arrives', () => {
    expect(isDueKeptProviderCycle(existing, '2026-09-09')).toBe(false);
    expect(isDueKeptProviderCycle(existing, '2026-09-10')).toBe(true);
    expect(isDueKeptProviderCycle(existing, '2026-09-11')).toBe(true);
    expect(isDueKeptProviderCycle({ ...existing, status: 'cancel' }, '2026-09-11')).toBe(false);
  });
});
