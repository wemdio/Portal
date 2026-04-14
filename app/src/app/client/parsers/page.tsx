'use client';

import { useState } from 'react';
import { HHParserView } from '@/components/parsers/HHParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { EmailSequenceView } from '@/components/email-sequence/EmailSequenceView';

type Tab = 'hh' | 'search' | 'yandexmaps' | 'email-sequence';

export default function ClientParsersPage() {
  const [activeTab, setActiveTab] = useState<Tab>('hh');

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Инструменты</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Парсеры и генерация контента
        </p>
      </div>

      <div className="mb-6">
        <div className="inline-flex rounded-xl p-1 neu-inset">
          <button
            type="button"
            onClick={() => setActiveTab('hh')}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition ${
              activeTab === 'hh'
                ? 'neu-card shadow-sm'
                : 'text-[var(--cp-text-m)] hover:text-[var(--cp-text)]'
            }`}
          >
            HH.ru парсер
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('search')}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition ${
              activeTab === 'search'
                ? 'neu-card shadow-sm'
                : 'text-[var(--cp-text-m)] hover:text-[var(--cp-text)]'
            }`}
          >
            Поиск
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('yandexmaps')}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition ${
              activeTab === 'yandexmaps'
                ? 'neu-card shadow-sm'
                : 'text-[var(--cp-text-m)] hover:text-[var(--cp-text)]'
            }`}
          >
            Яндекс.Карты
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('email-sequence')}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition ${
              activeTab === 'email-sequence'
                ? 'neu-card shadow-sm'
                : 'text-[var(--cp-text-m)] hover:text-[var(--cp-text)]'
            }`}
          >
            Цепочки писем
          </button>
        </div>
      </div>

      {activeTab === 'hh' && <HHParserView clientMode />}
      {activeTab === 'search' && <SearchParserView clientMode />}
      {activeTab === 'yandexmaps' && <YandexMapsParserView clientMode />}
      {activeTab === 'email-sequence' && <EmailSequenceView clientMode />}
    </div>
  );
}
