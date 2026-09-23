/** @jest-environment node */

/**
 * Людская доля бюджета LIST /emails (миграция 20260922_0001).
 *
 * Пиним клиентскую половину контракта:
 *  1. приоритет 'interactive' уходит в RPC как p_priority;
 *  2. отказ по своей доле ('interactive_budget') распознаётся как бюджетная
 *     отсрочка с retry_after, а НЕ как сломанное хранилище. Ровно эта ошибка
 *     случилась при появлении 'bulk_budget' (16.09.2026): новую причину не
 *     знал один из потребителей, обычный отказ полосы читался как
 *     storage_unavailable и ронял ночную синхронизацию.
 */

import {
  isBudgetDeferralReason,
  readInstantlyEmailReadDeferral,
} from '@/lib/instantly/emailReadDeferral';

const mockEmailBudgetRpc = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockEmailBudgetRpc(...args) },
}));

jest.mock('@/lib/instantly/usageCounters', () => ({
  recordInstantlyApiUsage: jest.fn(),
}));

function rpcReturns(data: unknown) {
  mockEmailBudgetRpc.mockReturnValue({
    abortSignal: () => Promise.resolve({ data, error: null }),
  });
}

describe('reserveInstantlyEmailRead — приоритет interactive', () => {
  beforeEach(() => {
    jest.resetModules();
    mockEmailBudgetRpc.mockReset();
  });

  it('передаёт p_priority = interactive в функцию бюджета', async () => {
    rpcReturns({ granted: true, retry_after_ms: 0 });
    const { reserveInstantlyEmailRead } = await import('@/lib/instantly/emailReadBudget');

    await reserveInstantlyEmailRead('acc-1', 'interactive', undefined, 'client_thread');

    expect(mockEmailBudgetRpc).toHaveBeenCalledWith('instantly_reserve_email_read', {
      p_account: 'acc-1',
      p_priority: 'interactive',
    });
  });

  it('отказ interactive_budget — бюджетная отсрочка, а не сломанное хранилище', async () => {
    rpcReturns({ granted: false, reason: 'interactive_budget', retry_after_ms: 7000 });
    const { reserveInstantlyEmailRead } = await import('@/lib/instantly/emailReadBudget');

    const err = await reserveInstantlyEmailRead('acc-2', 'interactive').then(
      () => null,
      (e: unknown) => e,
    );

    const deferral = readInstantlyEmailReadDeferral(err);
    expect(deferral).toEqual({ reason: 'interactive_budget', retryAfterMs: 7000 });
    expect(isBudgetDeferralReason(deferral!.reason)).toBe(true);
  });
});

describe('readInstantlyEmailReadDeferral — interactive_budget', () => {
  it('парсит причину из текста ошибки (обёртки сохраняют только message)', () => {
    expect(readInstantlyEmailReadDeferral(
      new Error('Instantly email read deferred: interactive_budget; retry after 9000 ms'),
    )).toEqual({ reason: 'interactive_budget', retryAfterMs: 9000 });
  });
});
