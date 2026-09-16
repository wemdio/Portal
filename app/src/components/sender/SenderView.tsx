'use client';

import { useState } from 'react';
import { MailboxesTab } from './MailboxesTab';
import { CampaignsTab } from './CampaignsTab';
import { RepliesTab } from './RepliesTab';

const TABS = [
  { id: 'mailboxes', label: 'Ящики' },
  { id: 'campaigns', label: 'Кампании' },
  { id: 'replies', label: 'Ответы' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function SenderView() {
  const [tab, setTab] = useState<TabId>('mailboxes');

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">Рассылка</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Своя отправка писем с подключённых ящиков провайдера. Ящики и домены покупаются и прогреваются на стороне
          провайдера — портал только подключает их файлом и ведёт рассылку.
        </p>
      </div>

      <div className="mb-6 flex gap-2 border-b border-zinc-200">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
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

      {tab === 'mailboxes' ? <MailboxesTab /> : null}
      {tab === 'campaigns' ? <CampaignsTab /> : null}
      {tab === 'replies' ? <RepliesTab /> : null}
    </div>
  );
}
