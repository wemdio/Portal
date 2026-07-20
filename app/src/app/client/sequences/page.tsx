'use client';

import { useEffect, useState } from 'react';
import { EmailSequenceV2View } from '@/components/email-sequence-v2/EmailSequenceV2View';
import { clientApiFetch } from '@/lib/clientFetcher';
import { useDemoMode } from '@/lib/clientDemo/useDemoMode';
import { DemoSequenceExample } from '@/components/client/DemoSequenceExample';
import { ToolPaywallCard } from '@/components/client/ToolPaywallCard';

type TariffStatus = 'setup' | 'active' | 'expired' | 'inactive';

/**
 * «Цепочки писем» — отдельная страница (июль 2026, IA-переработка).
 * Раньше генератор жил табом внутри «Инструментов парсинга», что путало:
 * генерация контента — не парсинг. Старый URL /client/parsers?tab=email-sequence
 * редиректит сюда (см. client/parsers/page.tsx).
 */
export default function ClientSequencesPage() {
  const isDemo = useDemoMode();
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
    // Широкий контейнер: генератор — плотный инструмент (колонка-редактор +
    // сайдбар «Последние запуски»), под кэпом кабинета 1600px max-w-7xl
    // наполняется целиком.
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 sm:mb-8">
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Цепочки писем
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          AI-генерация цепочки по брифу, ценностям и аудитории
        </p>
      </header>

      {tariffLoading ? null : tariffNotPaid ? (
        <ToolPaywallCard variant="unpaid" />
      ) : awaitingPayment ? (
        <ToolPaywallCard variant="awaiting" />
      ) : isDemo === true ? (
        // Демо: read-only пример «вход → цепочка» (tools-API демо-аккаунту
        // недоступен, у живого инструмента был бы пустой список запусков).
        <DemoSequenceExample />
      ) : isDemo === false ? (
        <EmailSequenceV2View clientMode />
      ) : null}
    </div>
  );
}
