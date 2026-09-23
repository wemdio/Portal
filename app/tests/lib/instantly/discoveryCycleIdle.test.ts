/** @jest-environment node */

/**
 * Отказ бюджета чтения писем не должен считаться «простоем» discovery.
 *
 * Прод 22.09.2026: после отказа бюджета цикл писал «No new replies» и
 * разгонял интервал опроса до 10–15 минут (отказ в 19:33 → сон 600 с → 900 с),
 * хотя к Instantly даже не ходил. Если вебхук об ответе терялся, запасной
 * опрос опаздывал на это время.
 */

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('@/lib/supabaseInstantly', () => ({ supabaseInstantly: null }));

import {
  discoveryCycleIsIdle,
  runDiscoveryAcrossAccounts,
} from '@/lib/instantly/leadQualificationWorker';

const ok = (staged: number) => async () => ({ staged, pages: 1, sweepComplete: true });

describe('discoveryCycleIsIdle', () => {
  const base = { staged: 0, errored: false, deferred: false, replyActivity: false };

  it('посмотрели и нашли пусто — простой', () => {
    expect(discoveryCycleIsIdle(base)).toBe(true);
  });

  it('отказ бюджета — не простой', () => {
    expect(discoveryCycleIsIdle({ ...base, deferred: true })).toBe(false);
  });

  it('прежние причины сброса не сломаны: новые ответы, ошибка, вебхук', () => {
    expect(discoveryCycleIsIdle({ ...base, staged: 1 })).toBe(false);
    expect(discoveryCycleIsIdle({ ...base, errored: true })).toBe(false);
    expect(discoveryCycleIsIdle({ ...base, replyActivity: true })).toBe(false);
  });
});

describe('runDiscoveryAcrossAccounts', () => {
  const campaigns = new Map([
    ['main', new Set(['c1'])],
    ['account-2', new Set(['c2'])],
    ['empty', new Set<string>()],
  ]);

  it('отказ бюджета одного аккаунта помечает цикл deferred, остальные аккаунты читаются', async () => {
    const calls: string[] = [];
    const result = await runDiscoveryAcrossAccounts(campaigns, async (accountId) => {
      calls.push(accountId);
      if (accountId === 'main') {
        throw Object.assign(new Error('Instantly email read deferred: budget; retry after 12000 ms'), {
          name: 'InstantlyEmailReadDeferredError', reason: 'budget', retryAfterMs: 12000,
        });
      }
      return ok(2)();
    });
    expect(calls).toEqual(['main', 'account-2']);
    expect(result).toEqual({ staged: 2, deferred: true });
  });

  it('обычная ошибка аккаунта (не бюджет) — не deferred, чтобы сломанный аккаунт не держал опрос на 30 с', async () => {
    const result = await runDiscoveryAcrossAccounts(campaigns, async (accountId) => {
      if (accountId === 'account-2') throw new Error('Instantly account "account-2" is not configured');
      return ok(0)();
    });
    expect(result).toEqual({ staged: 0, deferred: false });
  });

  it('отказ хранилища бюджета тоже считается отказом (к Instantly не ходили)', async () => {
    const result = await runDiscoveryAcrossAccounts(new Map([['main', new Set(['c1'])]]), async () => {
      throw new Error('Instantly email read deferred: storage_unavailable; retry after 30000 ms');
    });
    expect(result.deferred).toBe(true);
  });

  it('всё прочитано — не deferred', async () => {
    const result = await runDiscoveryAcrossAccounts(campaigns, ok(1));
    expect(result).toEqual({ staged: 2, deferred: false });
  });
});
