import { paymentRequestBelongsToMonth } from '@/lib/payments/monthMembership';

describe('paymentRequestBelongsToMonth', () => {
  it.each([
    [
      'keeps a request in its expected month when the actual payment belongs elsewhere',
      { expectedPaymentOn: '2026-08-20', paidOn: '2026-07-31' },
      '2026-08',
      true,
    ],
    [
      'keeps a request in its actual paid month when the expected payment belongs elsewhere',
      { expectedPaymentOn: '2026-07-20', paidOn: '2026-08-02' },
      '2026-08',
      true,
    ],
    [
      'removes a request when neither date belongs to the open month',
      { expectedPaymentOn: '2026-07-20', paidOn: '2026-07-31' },
      '2026-08',
      false,
    ],
    [
      'does not invent an actual paid month for an unpaid request',
      { expectedPaymentOn: '2026-07-20', paidOn: null },
      '2026-08',
      false,
    ],
  ])('%s', (_case, request, month, expected) => {
    expect(paymentRequestBelongsToMonth(request, month)).toBe(expected);
  });
});
