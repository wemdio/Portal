import type { PaymentRequest } from '@/lib/payments/types';

type PaymentMonthDates = Pick<PaymentRequest, 'expectedPaymentOn' | 'paidOn'>;

export function paymentRequestBelongsToMonth(
  request: PaymentMonthDates,
  month: string,
): boolean {
  return request.expectedPaymentOn.slice(0, 7) === month
    || request.paidOn?.slice(0, 7) === month;
}
