'use client';

import { useState } from 'react';

import { getDaysInMonth, getFirstDayOfMonth, mskDateStr, parseDateStr, toDateStr } from '@/lib/techCalendar/dates';
import { addMoney, emptyTotals, formatMoney, formatTotals, type MoneyTotals } from '@/lib/techCalendar/money';
import { STATUS_LABELS, type TechRenewalEvent, type TechSubscription } from '@/lib/techCalendar/types';
import { STATUS_STYLES } from '@/components/tech-calendar/statusStyles';

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const MONTH_NAMES_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Сколько сервисов показываем в клетке. Дальше — плашка «+N ещё»: в день
// переоформления пула прокси их бывает с десяток, и клетка растягивала строку
// календаря на пол-экрана, пряча соседние дни под скролл.
const VISIBLE_PER_DAY = 3;

// Запись дня: живая строка подписки на дату будущего списания либо оплаченное
// продление из журнала на дату оплаты. Продления остаются в месяце, где ушли
// деньги, — без этого оплаченный цикл уезжал в следующий вместе со строкой.
type CalendarEntry =
  | { kind: 'subscription'; sub: TechSubscription }
  | { kind: 'renewal'; event: TechRenewalEvent };

function formatDayLabel(dateStr: string): string {
  const { month, day } = parseDateStr(dateStr);
  return `${day} ${MONTH_NAMES_GENITIVE[month]}`;
}

function pluralSubs(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'подписка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'подписки';
  return 'подписок';
}

interface Props {
  subscriptions: TechSubscription[];
  renewed: TechRenewalEvent[];
  year: number;
  month: number;
  today: string;
  onSelect: (sub: TechSubscription) => void;
}

function dayTotals(entries: CalendarEntry[]): MoneyTotals {
  return entries.reduce((acc, entry) => {
    if (entry.kind === 'renewal') return addMoney(acc, entry.event.currency, entry.event.amount);
    const s = entry.sub;
    if (s.status === 'cancel' || s.is_hidden) return acc;
    return addMoney(acc, s.currency, s.amount);
  }, emptyTotals());
}

function SubscriptionChip({ sub, onSelect }: { sub: TechSubscription; onSelect: Props['onSelect'] }) {
  const style = STATUS_STYLES[sub.status];
  return (
    <button
      type="button"
      onClick={() => onSelect(sub)}
      className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] ${style.bg} ${style.text} ${sub.is_hidden ? 'opacity-45 line-through' : ''}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span className="truncate">{sub.service_name}</span>
      <span className="ml-auto shrink-0">{formatMoney(sub.amount, sub.currency)}</span>
    </button>
  );
}

function RenewalChip({ event }: { event: TechRenewalEvent }) {
  return (
    <div
      title={`Продлено: оплачен цикл на ${formatDayLabel(event.billing_date)}`}
      className="flex w-full items-center gap-1 rounded bg-emerald-50 px-1.5 py-1 text-left text-[11px] text-emerald-700"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">{event.service_name}</span>
      <span className="ml-auto shrink-0">{formatMoney(event.amount, event.currency)}</span>
    </div>
  );
}

function SubscriptionRow({ sub, onSelect }: { sub: TechSubscription; onSelect: Props['onSelect'] }) {
  const style = STATUS_STYLES[sub.status];
  return (
    <button
      type="button"
      onClick={() => onSelect(sub)}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-gray-50"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span className={`truncate ${sub.is_hidden ? 'text-gray-400 line-through' : ''}`}>{sub.service_name}</span>
      <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 ${style.bg} ${style.text}`}>
        {STATUS_LABELS[sub.status]}
      </span>
      <span className="shrink-0 font-medium">{formatMoney(sub.amount, sub.currency)}</span>
    </button>
  );
}

function RenewalRow({ event }: { event: TechRenewalEvent }) {
  return (
    <div
      title={`Оплачен цикл на ${formatDayLabel(event.billing_date)}`}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">{event.service_name}</span>
      <span className="ml-auto shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">Продлено</span>
      <span className="shrink-0 font-medium">{formatMoney(event.amount, event.currency)}</span>
    </div>
  );
}

export default function MonthGrid({ subscriptions, renewed, year, month, today, onSelect }: Props) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  // Попап дня: в клетке помещаются два-три сервиса, а в день переоформления
  // пула прокси их бывает с десяток — итог за день иначе пришлось бы считать
  // глазами.
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDate = new Map<string, CalendarEntry[]>();
  const push = (dateStr: string, entry: CalendarEntry) => {
    const list = byDate.get(dateStr) ?? [];
    list.push(entry);
    byDate.set(dateStr, list);
  };
  for (const sub of subscriptions) {
    push(sub.next_billing_date, { kind: 'subscription', sub });
  }
  for (const event of renewed) {
    push(mskDateStr(new Date(event.paid_at)), { kind: 'renewal', event });
  }

  const openEntries = openDay ? (byDate.get(openDay) ?? []) : [];
  const openSubCount = openEntries.filter((e) => e.kind === 'subscription').length;
  const openRenewalCount = openEntries.length - openSubCount;

  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-100 bg-white">
      <div className="grid grid-cols-7 border-b border-gray-100">
        {DAY_NAMES.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-500">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`pad-${i}`} className="min-h-24 border-b border-r border-gray-50" />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const dateStr = toDateStr(year, month, day);
          const entries = byDate.get(dateStr) ?? [];
          const isToday = dateStr === today;
          return (
            <div key={dateStr} className="min-h-24 border-b border-r border-gray-50 p-1.5 align-top">
              <button
                type="button"
                onClick={() => setOpenDay(entries.length ? dateStr : null)}
                className={`mb-1 text-xs ${isToday ? 'font-semibold text-blue-600' : 'text-gray-400'}`}
              >
                {day}
              </button>
              <div className="space-y-1">
                {entries.slice(0, VISIBLE_PER_DAY).map((entry) =>
                  entry.kind === 'subscription' ? (
                    <SubscriptionChip key={entry.sub.id} sub={entry.sub} onSelect={onSelect} />
                  ) : (
                    <RenewalChip key={entry.event.id} event={entry.event} />
                  ),
                )}
                {entries.length > VISIBLE_PER_DAY && (
                  <button
                    type="button"
                    onClick={() => setOpenDay(dateStr)}
                    className="w-full rounded bg-amber-100 px-1.5 py-0.5 text-center text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-200"
                  >
                    +{entries.length - VISIBLE_PER_DAY} ещё
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {openDay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 p-4" onClick={() => setOpenDay(null)}>
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-900">
                {formatDayLabel(openDay)}
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {openSubCount} {pluralSubs(openSubCount)}
                  {openRenewalCount > 0 && ` · ${openRenewalCount} продлено`}
                </span>
              </div>
              <button type="button" onClick={() => setOpenDay(null)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="space-y-1">
              {openEntries.map((entry) =>
                entry.kind === 'subscription' ? (
                  <SubscriptionRow
                    key={entry.sub.id}
                    sub={entry.sub}
                    onSelect={(sub) => {
                      setOpenDay(null);
                      onSelect(sub);
                    }}
                  />
                ) : (
                  <RenewalRow key={entry.event.id} event={entry.event} />
                ),
              )}
            </div>
            <div className="mt-3 border-t border-gray-100 pt-2 text-sm font-medium text-gray-900">
              Итого: {formatTotals(dayTotals(openEntries)).join(' · ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
