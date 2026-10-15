'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MailboxesTab } from './MailboxesTab';
import { CampaignsTab } from './CampaignsTab';
import { EgressTab } from './EgressTab';
import { SENDER_TABS, SenderRail, type SenderTabId } from './SenderRail';
import { SeedBoxesTab } from './SeedBoxesTab';
import { StatsTab } from './StatsTab';
import { StoplistTab } from './StoplistTab';
import { ThreadsTab } from './ThreadsTab';

const TABS = SENDER_TABS;
type TabId = SenderTabId;

/**
 * Вкладка из адреса: ?tab=mailboxes. Без вкладки открываются «Кампании»;
 * ссылка на переписку (?thread=<id>) — в «Письма».
 */
function initialTab(tab: string | null, threadId: string | null): TabId {
  const known = TABS.find((item) => item.id === tab);
  if (known) return known.id as TabId;
  return threadId ? 'threads' : 'campaigns';
}

/**
 * Страница «Рассылка». Адрес /tools/sender?tab=campaigns&campaign=<id> сразу
 * открывает кампании и подсвечивает нужную: так ведёт кнопка «Открыть в
 * Рассылке» с экрана запуска автоаутрича — иначе рассылку запуска
 * приходилось бы искать глазами в списке. ?tab=threads&thread=<id> сразу
 * открывает переписку. Адрес читается один раз, при открытии страницы.
 */
export function SenderView() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabId>(() =>
    initialTab(searchParams.get('tab'), searchParams.get('thread')),
  );
  // Кампания из ссылки. Сбрасывается при смене вкладки: вернувшись в
  // «Кампании», человек ждёт обычный список, а не повторную подсветку.
  const [focusCampaignId, setFocusCampaignId] = useState<string | null>(() => searchParams.get('campaign'));
  // Переписка из ссылки (?thread=<id>): ведут ТГ-сообщение о лиде и вкладка
  // «Квалификация» автоаутрича. Открывается один раз, при заходе на страницу.
  const [initialThreadId] = useState<string | null>(() => searchParams.get('thread'));
  // Адрес, по которому кликнули во вкладке «Адреса отправки»: «Ящики»
  // открываются уже отфильтрованными по нему.
  const [egressIp, setEgressIp] = useState<string | null>(null);
  // Кампания, по которой нажали «Статистика» в списке: вкладка статистики
  // открывается сразу с ней.
  const [statsCampaignId, setStatsCampaignId] = useState<string | null>(null);

  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    // «Письма» — три колонки, как «Персонализированные ответы»: им нужна вся ширина.
    // Разделы — колонка значков у левого края окна, как в Instantly (15.10.2026).
    <div className="lg:pl-14">
    <SenderRail
      active={tab}
      onSelect={(next) => {
        setTab(next);
        setFocusCampaignId(null);
        setEgressIp(null);
        setStatsCampaignId(null);
      }}
    />

    <div className={`mx-auto px-6 pb-8 pt-5 ${tab === 'threads' ? 'max-w-none' : 'max-w-7xl'}`}>
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-zinc-900">{activeTab.label}</h1>
        <p className="mt-1 text-sm text-zinc-500">{activeTab.hint}</p>
      </div>

      {tab === 'mailboxes' ? <MailboxesTab initialEgressIp={egressIp} /> : null}
      {tab === 'campaigns' ? (
        <CampaignsTab
          focusCampaignId={focusCampaignId}
          onOpenStats={(campaignId) => {
            setStatsCampaignId(campaignId);
            setFocusCampaignId(null);
            setTab('stats');
          }}
        />
      ) : null}
      {tab === 'threads' ? <ThreadsTab initialThreadId={initialThreadId} /> : null}
      {tab === 'stats' ? <StatsTab key={statsCampaignId ?? 'all'} initialCampaignId={statsCampaignId} /> : null}
      {tab === 'seeds' ? <SeedBoxesTab /> : null}
      {tab === 'stoplist' ? <StoplistTab /> : null}
      {tab === 'egress' ? (
        <EgressTab
          onOpenMailboxes={(ip) => {
            setEgressIp(ip);
            setTab('mailboxes');
          }}
        />
      ) : null}
    </div>
    </div>
  );
}
