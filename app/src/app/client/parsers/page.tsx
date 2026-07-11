'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { HHParserView } from '@/components/parsers/HHParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { clientApiFetch } from '@/lib/clientFetcher';

type Tab = 'hh' | 'search' | 'yandexmaps';

function parseTab(value: string | null | undefined): Tab {
  if (value === 'hh' || value === 'search' || value === 'yandexmaps') {
    return value;
  }
  return 'hh';
}

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'hh', label: 'HH.ru парсер' },
  { tab: 'search', label: 'Поиск' },
  { tab: 'yandexmaps', label: 'Яндекс.Карты' },
];

type TariffStatus = 'setup' | 'active' | 'expired' | 'inactive';

export default function ClientParsersPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>(() => parseTab(searchParams?.get('tab')));
  const [tariffStatus, setTariffStatus] = useState<TariffStatus | null>(null);
  const [tariffLoading, setTariffLoading] = useState(true);

  // «Цепочки писем» переехали на свою страницу (IA-переработка, июль 2026) —
  // старые закладки/онбординг-ссылки на таб редиректим туда.
  useEffect(() => {
    if (searchParams?.get('tab') === 'email-sequence') {
      router.replace('/client/sequences');
    }
  }, [searchParams, router]);

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
    // Широкий контейнер: вкладки — плотные инструменты (панель 380px +
    // результаты), которым тесно в max-w-5xl. Под кэпом кабинета 1600px
    // (client/layout.tsx) max-w-7xl реально наполняется.
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 sm:mb-8">
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Инструменты парсинга
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Парсеры HH.ru, поисковой выдачи и Яндекс.Карт
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
        </>
      )}
    </div>
  );
}
