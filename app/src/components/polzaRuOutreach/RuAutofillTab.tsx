'use client';

import type { RuOutreachConfig } from '@/lib/polzaRuOutreach/types';
import { AutofillTab } from '@/components/outreach/AutofillTab';
import { RuLaunchPanel } from './ruAdapter';

/** Вкладка «Автодобор» русского автоаутрича: настройки сбора — панель запуска в режиме автодобора. */
export function RuAutofillTab() {
  return (
    <AutofillTab<Partial<RuOutreachConfig>>
      lang="ru"
      renderSettings={({ busy, initial, onClose, onSave }) => (
        <RuLaunchPanel mode="autofill" busy={busy} initial={initial} onClose={onClose} onStart={onSave} />
      )}
    />
  );
}
