'use client';

import { authFetchJson } from '@/lib/authFetch';
import type {
  PaymentRequestActionInput,
  PaymentRequestActionResponse,
  PaymentsReadModel,
  SubmitPaymentRequestInput,
  SubmitPaymentRequestResponse,
} from '@/lib/payments/types';

export function loadPayments(month: string, signal?: AbortSignal): Promise<PaymentsReadModel> {
  return authFetchJson<PaymentsReadModel>(`/api/payments?month=${encodeURIComponent(month)}`, { signal });
}

/** UUID для Idempotency-Key: одна отправка — один ключ, повтор — тот же ключ. */
export function newIdempotencyKey(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function submitPaymentRequest(
  input: SubmitPaymentRequestInput,
  idempotencyKey: string,
): Promise<SubmitPaymentRequestResponse> {
  return authFetchJson<SubmitPaymentRequestResponse>('/api/payments', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function updatePaymentRequest(
  id: string,
  input: PaymentRequestActionInput,
): Promise<PaymentRequestActionResponse> {
  return authFetchJson<PaymentRequestActionResponse>(`/api/payments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
