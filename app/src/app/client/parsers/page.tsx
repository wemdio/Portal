'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { HHParserView } from '@/components/parsers/HHParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { EmailSequenceV2View } from '@/components/email-sequence-v2/EmailSequenceV2View';
import { clientApiFetch } from '@/lib/clientFetcher';

type Tab = 'hh' | 'search' | 'yandexmaps' | 'email-sequence';

function parseTab(value: string | null | undefined): Tab {
  if (value === 'hh' || value === 'search' || value === 'yandexmaps' || value === 'email-sequence') {
    return value;
  }
  return 'hh';
}

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'hh', label: 'HH.ru парсер' },
  { tab: 'search', label: 'Поиск' },
  { tab: 'yandexmaps', label: 'Яндекс.Карты' },
  { tab: 'email-sequence', label: 'Цепочки писем' },
];

type TariffStatus = 'setup' | 'active' | 'expired' | 'inactive';

export default function ClientParsersPage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => parseTab(searchParams?.get('tab')));
  const [tariffStatus, setTariffStatus] = useState<TariffStatus | null>(null);
  const [tariffLoading, setTariffLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await clientApiFetch<{ status?: TariffStatus }>('/tariff');
        if (!cancelled) setTariffStatus(data.status ?? 'inactive');
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

  // «Не оплачен» = никогда не оплачивался или истёк срок оплаты. Setup
  // (оплачен, идёт настройка ЛК) и active — тариф оплачен, инструменты
  // разрешены (внутри инструментов есть свои проверки лимитов).
  const tariffNotPaid = tariffStatus === 'inactive' || tariffStatus === 'expired';

  return (
    // Широкий контейнер: все вкладки — плотные инструменты (парсеры с панелью
    // 380px + результаты, генератор цепочек с редактором + сайдбар), которым
    // тесно в max-w-5xl. Под кэпом кабинета 1600px (client/layout.tsx) max-w-7xl
    // (1280) реально наполняется, т.е. использует почти всю доступную ширину main.
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 sm:mb-8">
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Инструменты парсинга
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Парсеры и генерация контента
        </p>
      </header>

      {tariffLoading ? null : tariffNotPaid ? (
        <div className="neu-card p-6 sm:p-8 text-center">
          <p
            className="text-base sm:text-lg font-semibold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Тариф не оплачен
          </p>
          <p
            className="mt-2 text-sm"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Чтобы запускать инструменты парсинга, зайдите во вкладку «Тариф» и оплатите тариф.
          </p>
        </div>
      ) : (
        <>
          <nav className="flex gap-1 mb-6 flex-wrap" aria-label="Инструменты">
            {TABS.map(({ tab, label }) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`ds-nav-item px-4 py-2 text-xs ${activeTab === tab ? 'active' : ''}`}
                aria-current={activeTab === tab ? 'page' : undefined}
              >
                {label}
              </button>
            ))}
          </nav>

          {activeTab === 'hh' && <HHParserView clientMode />}
          {activeTab === 'search' && <SearchParserView clientMode />}
          {activeTab === 'yandexmaps' && <YandexMapsParserView clientMode />}
          {activeTab === 'email-sequence' && <EmailSequenceV2View clientMode />}
        </>
      )}
    </div>
  );
}
