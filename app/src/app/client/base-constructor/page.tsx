'use client';

import { useEffect, useState } from 'react';
import { BaseConstructorView } from '@/components/base-constructor/BaseConstructorView';
import { clientApiFetch } from '@/lib/clientFetcher';
import { ToolPaywallCard } from '@/components/client/ToolPaywallCard';

type TariffStatus = 'setup' | 'active' | 'expired' | 'inactive';

export default function ClientBaseConstructorPage() {
  const [tariffStatus, setTariffStatus] = useState<TariffStatus | null>(null);
  // Оформил подписку, но первая оплата ещё не поступила — инструмент закрыт.
  const [awaitingPayment, setAwaitingPayment] = useState(false);
  const [tariffLoading, setTariffLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await clientApiFetch<{ status?: TariffStatus; payment_locked?: boolean; paid_at?: string | null }>('/tariff');
        if (!cancelled) {
          setTariffStatus(data.status ?? 'inactive');
          setAwaitingPayment(data.payment_locked === true && !data.paid_at);
        }
      } catch {
        if (!cancelled) setTariffStatus('inactive');
      } finally {
        if (!cancelled) setTariffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tariffNotPaid = tariffStatus === 'inactive' || tariffStatus === 'expired';

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8">
        {/* Page eyebrow mirrors the sidebar group. «Базы» lives in
            CLIENT_NAV_GROUPS[0] («01 → Старт»), so the page eyebrow reads
            «01 → Старт» — same convention as /client (campaigns) and
            /client/leads. */}
        <p className="ds-eyebrow mb-2">
          01<span aria-hidden> → </span>Старт
        </p>
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Подготовить базу к запуску
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Загрузите файл — мы очистим базу, найдём почты, проверим сайты и подготовим её к рассылке
        </p>
      </header>
      {tariffLoading ? null : tariffNotPaid ? (
        <ToolPaywallCard variant="unpaid" />
      ) : awaitingPayment ? (
        <ToolPaywallCard variant="awaiting" />
      ) : (
        <BaseConstructorView clientMode />
      )}
    </div>
  );
}
