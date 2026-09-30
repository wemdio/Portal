'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { UnlinkedCampaignsView } from '@/components/unlinked-campaigns/UnlinkedCampaignsView';
import { ReplyPersonalizationView } from './ReplyPersonalizationView';

/**
 * Вкладки инструмента: ответы по проектам и кампании Instantly, которые портал
 * не привязал ни к одному проекту (их ответы не видны, пока кампания ничья).
 * «Кампании без проекта» были отдельной плиткой в списке инструментов — это
 * часть той же работы с ответами, а не самостоятельный инструмент.
 * Вкладка — в адресе (?tab=campaigns): ссылку можно переслать.
 */
const TABS = [
  { id: 'replies', label: 'Ответы' },
  { id: 'campaigns', label: 'Кампании без проекта' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function ReplyPersonalizationTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab: TabId = params.get('tab') === 'campaigns' ? 'campaigns' : 'replies';

  const switchTab = (next: TabId) => {
    if (next === tab) return;
    router.replace(next === 'replies' ? pathname : `${pathname}?tab=${next}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-gray-200 bg-white px-3 pt-2">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => switchTab(id)}
            aria-pressed={tab === id}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
              tab === id ? 'border-blue-500 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={`min-h-0 flex-1 ${tab === 'campaigns' ? 'overflow-y-auto' : ''}`}>
        {tab === 'campaigns' ? <UnlinkedCampaignsView /> : <ReplyPersonalizationView />}
      </div>
    </div>
  );
}
