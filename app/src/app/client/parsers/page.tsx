'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { X, HelpCircle } from 'lucide-react';
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

// Tabs named by the job / what you get, not the tool. A client thinks
// "I need companies to write to", not "I need to parse HH.ru".
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'hh', label: 'Компании из вакансий' },
  { tab: 'search', label: 'Поиск компаний' },
  { tab: 'yandexmaps', label: 'Бизнес с карт' },
  { tab: 'email-sequence', label: 'Цепочки писем' },
];

// Per-tab orientation: what it does and why, what you get, and the first move.
// The "output" line is the aha — it tells the client the concrete result they
// walk away with. Kept short on purpose: this teaches enough to start, then
// gets out of the way (dismissible).
const GUIDE: Record<Tab, { what: string; output: string; start: string }> = {
  hh: {
    what: 'Находит компании, которые прямо сейчас нанимают сотрудников на HH.ru. Нанимают, значит растут и есть бюджет: хорошие тёплые цели для рассылки.',
    output: 'Список компаний с сайтами и описанием.',
    start: 'Укажите роль (например, «менеджер по продажам») и регион.',
  },
  search: {
    what: 'Ищет компании в интернете по вашему запросу и сразу находит их рабочие почты.',
    output: 'Компании с email, сайтом и описанием — готово к рассылке.',
    start: 'Опишите, кого ищете: например, «производители мебели, Москва».',
  },
  yandexmaps: {
    what: 'Собирает локальный бизнес с Яндекс.Карт по городу и категории. Удобно, когда цель — конкретный регион и тип бизнеса.',
    output: 'Список организаций с контактами.',
    start: 'Выберите город и категорию бизнеса.',
  },
  'email-sequence': {
    what: 'Здесь вы готовите письма, которые уйдут вашей базе. Это не сбор базы, а текст рассылки.',
    output: 'Готовая цепочка писем для запуска кампании.',
    start: 'Опишите ваш оффер, дальше отредактируете текст.',
  },
};

const DISMISS_KEY = 'client.parsers.guideDismissed';

export default function ClientParsersPage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => parseTab(searchParams?.get('tab')));
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DISMISS_KEY);
      if (raw) setDismissed(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* localStorage unavailable — keep guides shown */
    }
  }, []);

  const persist = (next: Record<string, boolean>) => {
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const guide = GUIDE[activeTab];
  const guideHidden = !!dismissed[activeTab];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Сбор базы и письма
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Три способа собрать базу компаний для рассылки: из вакансий, поиска или Яндекс.Карт.
          Отдельно — цепочки писем.
        </p>
      </header>

      <nav className="flex items-center gap-1 mb-4 flex-wrap" aria-label="Инструменты">
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
        {guideHidden && (
          // Once dismissed, leave a quiet way back to the orientation.
          <button
            type="button"
            onClick={() => persist({ ...dismissed, [activeTab]: false })}
            className="ds-btn-ghost ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
          >
            <HelpCircle className="h-3.5 w-3.5" aria-hidden />
            Что это
          </button>
        )}
      </nav>

      {!guideHidden && (
        <div className="neu-card p-4 sm:p-5 mb-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm leading-relaxed m-0" style={{ color: 'var(--cp-paper)' }}>
                {guide.what}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="ds-eyebrow mb-1">что на выходе</p>
                  <p className="text-xs m-0" style={{ color: 'var(--cp-paper-mute)' }}>{guide.output}</p>
                </div>
                <div>
                  <p className="ds-eyebrow mb-1">с чего начать</p>
                  <p className="text-xs m-0" style={{ color: 'var(--cp-paper-mute)' }}>{guide.start}</p>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => persist({ ...dismissed, [activeTab]: true })}
              aria-label="Скрыть подсказку"
              className="ds-btn-ghost shrink-0 p-1.5"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {activeTab === 'hh' && <HHParserView clientMode />}
      {activeTab === 'search' && <SearchParserView clientMode />}
      {activeTab === 'yandexmaps' && <YandexMapsParserView clientMode />}
      {activeTab === 'email-sequence' && <EmailSequenceV2View clientMode />}
    </div>
  );
}
