'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Wrench, Briefcase, Search, MapPin, Sparkles } from 'lucide-react';
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

export default function ClientParsersPage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => parseTab(searchParams?.get('tab')));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold flex items-center gap-2.5">
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-xl"
            style={{ background: 'rgba(139,92,246,0.12)', color: '#8B5CF6' }}
          >
            <Wrench className="h-4.5 w-4.5" />
          </span>
          Инструменты парсинга
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Парсеры и генерация контента
        </p>
      </div>

      <div className="mb-6">
        <div className="inline-flex rounded-xl p-1 neu-inset flex-wrap gap-1">
          {([
            { tab: 'hh' as Tab, label: 'HH.ru парсер', icon: Briefcase, color: '#6366F1', bg: 'rgba(99,102,241,0.12)' },
            { tab: 'search' as Tab, label: 'Поиск', icon: Search, color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
            { tab: 'yandexmaps' as Tab, label: 'Яндекс.Карты', icon: MapPin, color: '#F43F5E', bg: 'rgba(244,63,94,0.12)' },
            { tab: 'email-sequence' as Tab, label: 'Цепочки писем', icon: Sparkles, color: '#F97316', bg: 'rgba(249,115,22,0.12)' },
          ] as const).map(({ tab, label, icon: Icon, color, bg }) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-semibold rounded-lg transition inline-flex items-center gap-2 ${
                activeTab === tab
                  ? 'neu-card shadow-sm'
                  : 'text-[var(--cp-text-m)] hover:text-[var(--cp-text)]'
              }`}
            >
              {activeTab === tab && (
                <span
                  className="inline-flex items-center justify-center w-6 h-6 rounded-md"
                  style={{ background: bg, color }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
              )}
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
