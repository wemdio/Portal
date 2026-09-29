'use client';

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { QualificationTab } from './QualificationTab';

const TABS = [
  { id: 'runs', label: 'Запуски' },
  { id: 'qualification', label: 'Квалификация' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Вкладка в адресе: ?tab=qualification. «Запуски» — основная, в адрес не пишется. */
function writeTabToUrl(tab: TabId): void {
  const url = new URL(window.location.href);
  if (tab === 'runs') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url.href);
}

/**
 * Вкладки автоаутрича: «Запуски» (экран запуска как был) и «Квалификация» —
 * история оценок ответов и настройки квалификатора папки «Рассылки»
 * (docs/superpowers/specs/2026-09-29-outreach-qualification-tab-design.md).
 *
 * «Запуски» не размонтируются при переключении: иначе выбранный запуск и
 * загруженные результаты терялись бы на каждом заходе в «Квалификацию».
 * «Квалификация» монтируется при первом открытии и дальше тоже живёт.
 */
export function OutreachTabs({ folderKey, children }: { folderKey: string; children: ReactNode }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabId>(() => (searchParams.get('tab') === 'qualification' ? 'qualification' : 'runs'));
  const [qualificationOpened, setQualificationOpened] = useState(tab === 'qualification');

  const select = (next: TabId) => {
    setTab(next);
    if (next === 'qualification') setQualificationOpened(true);
    writeTabToUrl(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-zinc-200">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => select(item.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === item.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className={tab === 'runs' ? '' : 'hidden'}>{children}</div>
      {qualificationOpened ? (
        <div className={tab === 'qualification' ? '' : 'hidden'}>
          <QualificationTab folderKey={folderKey} />
        </div>
      ) : null}
    </div>
  );
}
