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
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Инструменты парсинга</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Парсеры и генерация контента
        </p>
      </div>

      <div className="mb-6">
        <div className="inline-flex rounded-xl p-1 neu-inset flex-wrap gap-1">
          {TABS.map(({ tab, label }) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-semibold rounded-lg transition ${
                activeTab === tab
                  ? 'neu-card shadow-sm'
                  : 'text-[var(--cp-text-m)] hover:text-[var(--cp-text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'hh' && <HHParserView clientMode />}
      {activeTab === 'search' && <SearchParserView clientMode />}
      {activeTab === 'yandexmaps' && <YandexMapsParserView clientMode />}
      {activeTab === 'email-sequence' && <EmailSequenceV2View clientMode />}
    </div>
  );
}
