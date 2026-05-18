'use client';

import { useEffect, useState } from 'react';
import { clientApiFetch } from '@/lib/clientFetcher';

export type PaymentStatus = {
  payment_locked: boolean;
  billing_mode: 'invoice' | 'autopayment' | null;
  setup_until: string | null;
  paid_at: string | null;
};

/**
 * Returns the client's payment lock status.
 * null = loading, not yet known.
 */
export function usePaymentStatus(): PaymentStatus | null {
  const [status, setStatus] = useState<PaymentStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await clientApiFetch<PaymentStatus & Record<string, unknown>>('/tariff');
        if (!cancelled) {
          setStatus({
            payment_locked: res.payment_locked === true,
            billing_mode: (res.billing_mode as PaymentStatus['billing_mode']) ?? null,
            setup_until: (res.setup_until as string | null) ?? null,
            paid_at: (res.paid_at as string | null) ?? null,
          });
        }
      } catch {
        if (!cancelled) setStatus({ payment_locked: false, billing_mode: null, setup_until: null, paid_at: null });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return status;
}
