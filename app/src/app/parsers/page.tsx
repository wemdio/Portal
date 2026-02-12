
'use client';

import { useState } from 'react';
import { HHParserView } from '@/components/parsers/HHParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';

type Tab = 'hh' | 'search';

export default function ParsersPage() {
  const [activeTab, setActiveTab] = useState<Tab>('hh');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Парсеры</h1>
        <p className="text-sm text-gray-500 mt-1">Инструменты для сбора данных</p>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('hh')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'hh'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            HH.ru Парсер
          </button>
          <button
            onClick={() => setActiveTab('search')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'search'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Поисковая выдача
          </button>
        </nav>
      </div>

      {activeTab === 'hh' ? <HHParserView /> : <SearchParserView />}
    </div>
  );
}
