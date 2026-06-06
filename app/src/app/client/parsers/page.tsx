'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { HHParserView } from '@/components/parsers/HHParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { EmailSequenceV2View } from '@/components/email-sequence-v2/EmailSequenceV2View';

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

export default function ClientParsersPage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => parseTab(searchParams?.get('tab')));

  return (
    <div className="mx-auto max-w-5xl">
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
    </div>
  );
}
