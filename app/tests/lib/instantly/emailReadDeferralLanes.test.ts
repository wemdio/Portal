/** @jest-environment node */

import {
  readInstantlyEmailReadDeferral,
  isBudgetDeferralReason,
} from '@/lib/instantly/emailReadDeferral';
import { qualificationRecoveryBackoff } from '@/lib/instantly/qualificationRecovery';

describe('readInstantlyEmailReadDeferral — lane-специфичные причины', () => {
  it.each(['recovery_budget', 'bulk_budget'] as const)('парсит %s из Error.message', (reason) => {
    const parsed = readInstantlyEmailReadDeferral(
      new Error(`Instantly email read deferred: ${reason}; retry after 12000 ms`),
    );
    expect(parsed).toEqual({ reason, retryAfterMs: 12000 });
  });

  it('парсит причину из полей InstantlyEmailReadDeferredError-подобного объекта', () => {
    const err = Object.assign(new Error('wrapped'), {
      name: 'InstantlyEmailReadDeferredError',
      reason: 'bulk_budget',
      retryAfterMs: 4500.4,
    });
    expect(readInstantlyEmailReadDeferral(err)).toEqual({ reason: 'bulk_budget', retryAfterMs: 4501 });
  });

  it('старые причины не сломаны (budget/cooldown/storage_unavailable)', () => {
    expect(readInstantlyEmailReadDeferral(
      new Error('Instantly email read deferred: budget; retry after 45000 ms'),
    )?.reason).toBe('budget');
    expect(readInstantlyEmailReadDeferral(
      new Error('Instantly email read deferred: cooldown; retry after 6000 ms'),
    )?.reason).toBe('cooldown');
  });

  it('isBudgetDeferralReason отличает бюджетное семейство от cooldown/storage', () => {
    expect(isBudgetDeferralReason('budget')).toBe(true);
    expect(isBudgetDeferralReason('recovery_budget')).toBe(true);
    expect(isBudgetDeferralReason('bulk_budget')).toBe(true);
    expect(isBudgetDeferralReason('cooldown')).toBe(false);
    expect(isBudgetDeferralReason('storage_unavailable')).toBe(false);
  });
});

describe('qualificationRecoveryBackoff — lane-отказы не копят backoff', () => {
  const state = { id: 'qual-1', recovery_attempts: 3, recovery_failure_kind: 'provider_rate_limit', recovery_failure_count: 7 };
  const now = Date.parse('2026-09-15T10:00:00Z');

  it.each([
    ['budget', 'local_read_quota'],
    ['recovery_budget', 'local_read_quota'],
    ['bulk_budget', 'local_read_quota'],
  ] as const)('%s → %s без экспоненты', (reason, kind) => {
    const result = qualificationRecoveryBackoff(
      state,
      `Instantly email read deferred: ${reason}; retry after 30000 ms`,
      now,
      60_000,
    );
    expect(result.recovery_failure_kind).toBe(kind);
    expect(result.recovery_failure_count).toBe(0);
    // 10-60с + джиттер ≤5с: никакого наследования 15-минутного минимума лейна.
    const delay = Date.parse(result.recovery_next_at) - now;
    expect(delay).toBeGreaterThanOrEqual(10_000);
    expect(delay).toBeLessThanOrEqual(65_001);
  });

  it('cooldown по-прежнему provider_rate_limit', () => {
    const result = qualificationRecoveryBackoff(
      state,
      'Instantly email read deferred: cooldown; retry after 60000 ms',
      now,
      60_000,
    );
    expect(result.recovery_failure_kind).toBe('provider_rate_limit');
    // Тот же kind в state → счётчик продолжает копиться (7 → 8).
    expect(result.recovery_failure_count).toBe(8);
  });
});
