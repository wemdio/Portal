'use client';

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { QualificationTab } from './QualificationTab';

/** Своя вкладка языка после «Квалификации» (у русского — «Библиотеки»). */
export interface OutreachExtraTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Вкладка в адресе: ?tab=qualification. «Запуски» — основная, в адрес не пишется. */
function writeTabToUrl(tab: string): void {
  const url = new URL(window.location.href);
  if (tab === 'runs') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url.href);
}

/**
 * Вкладки автоаутрича: «Запуски» (экран запуска), «Квалификация» — история
 * оценок ответов и настройки квалификатора папки «Рассылки»
 * (docs/superpowers/specs/2026-09-29-outreach-qualification-tab-design.md) —
 * и свои вкладки языка.
 *
 * «Запуски» не размонтируются при переключении: иначе выбранный запуск и
 * загруженные результаты терялись бы на каждом заходе в соседнюю вкладку.
 * Остальные монтируются при первом открытии и дальше тоже живут.
 */
export function OutreachTabs({
  folderKey,
  extraTabs = [],
  children,
}: {
  folderKey: string;
  extraTabs?: OutreachExtraTab[];
  children: ReactNode;
}) {
  const tabs = [
    { id: 'runs', label: 'Запуски' },
    { id: 'qualification', label: 'Квалификация' },
    ...extraTabs.map(({ id, label }) => ({ id, label })),
  ];
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<string>(() => {
    const fromUrl = searchParams.get('tab');
    return tabs.some((t) => t.id === fromUrl) ? fromUrl! : 'runs';
  });
  const [opened, setOpened] = useState<Set<string>>(() => new Set([tab]));

  const select = (next: string) => {
    setTab(next);
    setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    writeTabToUrl(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-zinc-200">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => select(item.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === item.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className={tab === 'runs' ? '' : 'hidden'}>{children}</div>
      {opened.has('qualification') ? (
        <div className={tab === 'qualification' ? '' : 'hidden'}>
          <QualificationTab folderKey={folderKey} />
        </div>
      ) : null}
      {extraTabs.map((extra) =>
        opened.has(extra.id) ? (
          <div key={extra.id} className={tab === extra.id ? '' : 'hidden'}>
            {extra.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
