
'use client';

import { useState } from 'react';
import { HHParserView } from '@/components/parsers/HHParserView';
import { HHArchiveParserView } from '@/components/parsers/HHArchiveParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { CryptoPaymentParserView } from '@/components/parsers/CryptoPaymentParserView';
import { YandexDirectParserView } from '@/components/parsers/YandexDirectParserView';

type Tab = 'hh' | 'hh-archive' | 'search' | 'yandexmaps' | 'yandexdirect' | 'crypto';

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
            onClick={() => setActiveTab('hh-archive')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'hh-archive'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            HH.ru Архив
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
          <button
            onClick={() => setActiveTab('yandexmaps')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'yandexmaps'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Яндекс.Карты
          </button>
          <button
            onClick={() => setActiveTab('yandexdirect')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'yandexdirect'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Яндекс.Директ
          </button>
          <button
            onClick={() => setActiveTab('crypto')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'crypto'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Crypto Payments
          </button>
        </nav>
      </div>

      {activeTab === 'hh'
        ? <HHParserView />
        : activeTab === 'hh-archive'
          ? <HHArchiveParserView />
          : activeTab === 'search'
            ? <SearchParserView />
            : activeTab === 'yandexmaps'
              ? <YandexMapsParserView />
              : activeTab === 'yandexdirect'
                ? <YandexDirectParserView />
                : <CryptoPaymentParserView />}
    </div>
  );
}
