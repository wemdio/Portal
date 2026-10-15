'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { Ban, BarChart3, Inbox, Mail, Network, Send, ShieldCheck, type LucideIcon } from 'lucide-react';

// «Письма» — переписка после отправки: воркер читает входящие по IMAP, сводит
// их с получателями кампаний и обрывает цепочку ответившим. Ответы лиду
// пишутся прямо там же (задача 4.1); разбор входящих остаётся в инструменте
// «Персонализированные ответы».
// hint — одна строка под заголовком: что на вкладке можно сделать.
export const SENDER_TABS: ReadonlyArray<{ id: SenderTabId; label: string; hint: string; icon: LucideIcon }> = [
  { id: 'campaigns', label: 'Кампании', hint: 'Создавайте, запускайте и ставьте на паузу рассылки.', icon: Send },
  { id: 'mailboxes', label: 'Ящики', hint: 'Подключайте ящики и задавайте им дневные лимиты.', icon: Inbox },
  { id: 'threads', label: 'Письма', hint: 'Читайте ответы и отвечайте лидам прямо отсюда.', icon: Mail },
  { id: 'stats', label: 'Статистика', hint: 'Смотрите отправки, ответы и отбои по дням и кампаниям.', icon: BarChart3 },
  { id: 'seeds', label: 'Контрольные ящики', hint: 'Проверяйте, попадают письма во входящие или в спам.', icon: ShieldCheck },
  { id: 'stoplist', label: 'Стоп-лист', hint: 'Адреса, которым рассылка больше не пишет.', icon: Ban },
  { id: 'egress', label: 'Адреса отправки', hint: 'С каких IP уходят письма и какие ящики на каждом.', icon: Network },
];

export type SenderTabId = 'campaigns' | 'mailboxes' | 'threads' | 'stats' | 'seeds' | 'stoplist' | 'egress';

/**
 * Панель разделов «Рассылки»: колонка значков у левого края окна, как в
 * Instantly; на узких экранах — горизонтальная строка. Общая для списка и
 * страниц кампании, чтобы при входе в кампанию панель не пропадала.
 */
export function SenderRail({ active, onSelect }: { active: SenderTabId; onSelect: (tab: SenderTabId) => void }) {
  // Колонка прижата к левому краю окна на всю высоту: верх — сразу под шапкой
  // портала, высоту шапки берём из страницы.
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

  return (
    <>
      <nav
        aria-label="Разделы рассылки"
        style={{ top: railTop, height: `calc(100vh - ${railTop}px)` }}
        className="fixed left-0 z-30 hidden w-14 flex-col items-center justify-center gap-1 border-r border-zinc-200 bg-white py-3 lg:flex"
      >
        {SENDER_TABS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
              className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
                isActive ? 'bg-blue-600/10 text-blue-600' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
              }`}
            >
              <Icon className="h-[18px] w-[18px]" />
            </button>
          );
        })}
      </nav>

      {/* На узких экранах колонки нет — разделы лежат горизонтальной строкой. */}
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 lg:hidden">
        {SENDER_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${
              active === item.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-zinc-500'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Страница кампании (создание, настройки) с той же панелью разделов: кампания —
 * часть вкладки «Кампании», клик по другому разделу ведёт в список на него.
 */
export function SenderRailFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <div className="lg:pl-14">
      <SenderRail
        active="campaigns"
        // `as Route` — типизированные маршруты не выводят адрес с query-строкой.
        onSelect={(tab) => router.push((tab === 'campaigns' ? '/tools/sender' : `/tools/sender?tab=${tab}`) as Route)}
      />
      {children}
    </div>
  );
}
