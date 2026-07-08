
'use client';

import { useState } from 'react';
import { HHParserView } from '@/components/parsers/HHParserView';
import { HHArchiveParserView } from '@/components/parsers/HHArchiveParserView';
import { SearchParserView } from '@/components/parsers/SearchParserView';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { CryptoPaymentParserView } from '@/components/parsers/CryptoPaymentParserView';
import { YandexDirectParserView } from '@/components/parsers/YandexDirectParserView';
import { AtsParserView } from '@/components/parsers/AtsParserView';
import { EngHiringParserView } from '@/components/parsers/EngHiringParserView';
import { EuUsCompanyBaseView } from '@/components/parsers/EuUsCompanyBaseView';
import { CrunchbaseParserView } from '@/components/parsers/CrunchbaseParserView';
import { GoogleMapsParserView } from '@/components/parsers/GoogleMapsParserView';
import { GoogleNewsParserView } from '@/components/parsers/GoogleNewsParserView';

type Tab = 'hh' | 'eng-hiring' | 'ats' | 'crunchbase' | 'eu-us-base' | 'hh-archive' | 'search' | 'yandexmaps' | 'yandexdirect' | 'crypto' | 'googlemaps' | 'googlenews';

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
            onClick={() => setActiveTab('eng-hiring')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'eng-hiring'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            ENG вакансии
            <span className="ml-1.5 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-normal text-blue-700 align-middle">6 ATS sources</span>
          </button>
          <button
            onClick={() => setActiveTab('crunchbase')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'crunchbase'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Crunchbase
            <span className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-normal text-emerald-700 border border-emerald-200 align-middle">стартапы · раунды</span>
          </button>
          <button
            onClick={() => setActiveTab('eu-us-base')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'eu-us-base'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            EU/US · База компаний
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
          <button
            onClick={() => setActiveTab('googlemaps')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'googlemaps'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Google Maps
          </button>
          <button
            onClick={() => setActiveTab('googlenews')}
            className={`
              whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'googlenews'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            Google News
          </button>
        </nav>
      </div>

      {activeTab === 'hh' && <HHParserView />}
      {activeTab === 'eng-hiring' && <EngHiringParserView />}
      {activeTab === 'ats' && <AtsParserView />}
      {activeTab === 'crunchbase' && <CrunchbaseParserView />}
      {activeTab === 'eu-us-base' && <EuUsCompanyBaseView />}
      {activeTab === 'hh-archive' && <HHArchiveParserView />}
      {activeTab === 'search' && <SearchParserView />}
      {activeTab === 'yandexmaps' && <YandexMapsParserView />}
      {activeTab === 'yandexdirect' && <YandexDirectParserView />}
      {activeTab === 'crypto' && <CryptoPaymentParserView />}
      {activeTab === 'googlemaps' && <GoogleMapsParserView />}
      {activeTab === 'googlenews' && <GoogleNewsParserView />}
    </div>
  );
}
