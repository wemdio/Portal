'use client';

import type { PolzaOutreachConfig } from '@/types';
import { AutofillTab } from '@/components/outreach/AutofillTab';
import { PolzaOutreachLaunchPanel } from './PolzaOutreachLaunchPanel';

/** Вкладка «Автодобор» английского автоаутрича: настройки сбора — панель запуска в режиме автодобора. */
export function EnAutofillTab() {
  return (
    <AutofillTab<PolzaOutreachConfig>
      lang="en"
      renderSettings={({ busy, initial, onClose, onSave }) => (
        <PolzaOutreachLaunchPanel
          mode="autofill"
          busy={busy}
          initial={initial}
          onClose={onClose}
          onStart={async (config) => onSave(config)}
        />
      )}
    />
  );
}
