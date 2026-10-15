'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Ban, BarChart3, Mail, MessageSquare, Network, Send, ShieldCheck, type LucideIcon } from 'lucide-react';
import { MailboxesTab } from './MailboxesTab';
import { CampaignsTab } from './CampaignsTab';
import { EgressTab } from './EgressTab';
import { SeedBoxesTab } from './SeedBoxesTab';
import { StatsTab } from './StatsTab';
import { StoplistTab } from './StoplistTab';
import { ThreadsTab } from './ThreadsTab';

// «Письма» — переписка после отправки: воркер читает входящие по IMAP, сводит
// их с получателями кампаний и обрывает цепочку ответившим. Ответы лиду
// пишутся прямо там же (задача 4.1); разбор входящих остаётся в инструменте
// «Персонализированные ответы».
const TABS: ReadonlyArray<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'campaigns', label: 'Кампании', icon: Send },
  { id: 'mailboxes', label: 'Ящики', icon: Mail },
  { id: 'threads', label: 'Письма', icon: MessageSquare },
  { id: 'stats', label: 'Статистика', icon: BarChart3 },
  { id: 'seeds', label: 'Контрольные ящики', icon: ShieldCheck },
  { id: 'stoplist', label: 'Стоп-лист', icon: Ban },
  { id: 'egress', label: 'Адреса отправки', icon: Network },
];

type TabId = 'campaigns' | 'mailboxes' | 'threads' | 'stats' | 'seeds' | 'stoplist' | 'egress';

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
  // Панель разделов прижата к левому краю окна на всю высоту (как в Instantly):
  // верх — сразу под шапкой портала, высоту шапки берём из страницы.
  const [railTop, setRailTop] = useState(56);
  useEffect(() => {
    const measure = () => {
      const header = document.querySelector('header');
      const bottom = header ? Math.round(header.getBoundingClientRect().bottom) : 56;
      setRailTop(Math.max(0, bottom));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, []);
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

  return (
    // «Письма» — три колонки, как «Персонализированные ответы»: им нужна вся ширина.
    // Разделы — колонка значков у левого края окна, как в Instantly (15.10.2026).
    <div className="lg:pl-14">
    <nav
      aria-label="Разделы рассылки"
      style={{ top: railTop, height: `calc(100vh - ${railTop}px)` }}
      className="fixed left-0 z-30 hidden w-14 flex-col items-center gap-1 border-r border-zinc-200 bg-white py-3 lg:flex"
    >
      {TABS.map((item) => {
        const Icon = item.icon;
        const active = tab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              setTab(item.id as TabId);
              setFocusCampaignId(null);
              setEgressIp(null);
              setStatsCampaignId(null);
            }}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              active ? 'bg-blue-600/10 text-blue-600' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
            }`}
          >
            <Icon className="h-[18px] w-[18px]" />
          </button>
        );
      })}
    </nav>

    {/* На узких экранах колонки нет — разделы лежат горизонтальной строкой. */}
    <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 lg:hidden">
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            setTab(item.id as TabId);
            setFocusCampaignId(null);
            setEgressIp(null);
            setStatsCampaignId(null);
          }}
          className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${
            tab === item.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-zinc-500'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>

    <div className={`mx-auto px-6 py-8 ${tab === 'threads' ? 'max-w-none' : 'max-w-7xl'}`}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">Рассылка</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Своя отправка писем с подключённых ящиков провайдера.
        </p>
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
