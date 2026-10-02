'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MailboxesTab } from './MailboxesTab';
import { CampaignsTab } from './CampaignsTab';
import { EgressTab } from './EgressTab';
import { StatsTab } from './StatsTab';
import { StoplistTab } from './StoplistTab';
import { ThreadsTab } from './ThreadsTab';

// «Письма» — переписка после отправки: воркер читает входящие по IMAP, сводит
// их с получателями кампаний и обрывает цепочку ответившим. Ответы лиду
// пишутся прямо там же (задача 4.1); разбор входящих остаётся в инструменте
// «Персонализированные ответы».
const TABS = [
  { id: 'campaigns', label: 'Кампании' },
  { id: 'mailboxes', label: 'Ящики' },
  { id: 'threads', label: 'Письма' },
  { id: 'stats', label: 'Статистика' },
  { id: 'stoplist', label: 'Стоп-лист' },
  { id: 'egress', label: 'Адреса отправки' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/**
 * Вкладка из адреса: ?tab=mailboxes. Без вкладки открываются «Кампании»;
 * ссылка на переписку (?thread=<id>) — в «Письма».
 */
function initialTab(tab: string | null, threadId: string | null): TabId {
  const known = TABS.find((item) => item.id === tab);
  if (known) return known.id;
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">Рассылка</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Своя отправка писем с подключённых ящиков провайдера.
        </p>
      </div>

      <div className="mb-6 flex gap-2 border-b border-zinc-200">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTab(item.id);
              setFocusCampaignId(null);
              setEgressIp(null);
            }}
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

      {tab === 'mailboxes' ? <MailboxesTab initialEgressIp={egressIp} /> : null}
      {tab === 'campaigns' ? <CampaignsTab focusCampaignId={focusCampaignId} /> : null}
      {tab === 'threads' ? <ThreadsTab initialThreadId={initialThreadId} /> : null}
      {tab === 'stats' ? <StatsTab /> : null}
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
  );
}
