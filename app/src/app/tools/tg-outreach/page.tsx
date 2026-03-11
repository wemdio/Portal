'use client';

import { useState } from 'react';
import { AccountsTab } from '@/components/tg-outreach/AccountsTab';
import { ProxiesTab } from '@/components/tg-outreach/ProxiesTab';
import { TagManager } from '@/components/tg-outreach/TagManager';
import { useTgOutreachTags } from '@/lib/tgOutreach/hooks';
import { Tag } from 'lucide-react';

type Tab = 'accounts' | 'proxies';

export default function TgOutreachPage() {
  const [activeTab, setActiveTab] = useState<Tab>('accounts');
  const [showTagManager, setShowTagManager] = useState(false);
  const { tags, reload: reloadTags } = useTgOutreachTags();

  const tabs: { id: Tab; label: string }[] = [
    { id: 'accounts', label: 'Аккаунты' },
    { id: 'proxies', label: 'Прокси' },
  ];

  return (
    <div className="space-y-6 text-left max-w-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">TG Аутрич</h1>
          <p className="text-sm text-gray-500">
            Управление Telegram-аккаунтами и прокси для аутрича.
          </p>
        </div>
        <button
          onClick={() => setShowTagManager(true)}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 transition-colors"
        >
          <Tag className="h-4 w-4" />
          Теги
        </button>
      </div>

      <div className="flex gap-1 rounded-lg bg-zinc-100 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'accounts' ? (
        <AccountsTab allTags={tags} onTagsChange={reloadTags} />
      ) : (
        <ProxiesTab allTags={tags} onTagsChange={reloadTags} />
      )}

      {showTagManager && (
        <TagManager
          tags={tags}
          onClose={() => setShowTagManager(false)}
          onUpdate={reloadTags}
        />
      )}
    </div>
  );
}
