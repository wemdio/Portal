'use client';

import { useState } from 'react';
import { OutreachRunView } from '@/components/outreach/run/OutreachRunView';
import { Libraries } from './Libraries';
import { ruOutreachAdapter } from './ruAdapter';

/**
 * Наш (русский) автоаутрич: тот же экран запуска, что у английского, — свои
 * только шаги поиска, столбцы и выгрузки (ruAdapter.tsx).
 */
export function PolzaRuOutreachView() {
  return <OutreachRunView adapter={ruOutreachAdapter} />;
}

/**
 * Вкладка «Библиотеки» (офферы, кейсы, отправители) — рядом с «Запусками» и
 * «Квалификацией». Отправителей панель запуска перечитывает при открытии,
 * поэтому сообщать о правке наверх не нужно.
 */
export function PolzaRuLibrariesTab() {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div> : null}
      <Libraries onError={setError} onSendersChanged={() => undefined} />
    </div>
  );
}
