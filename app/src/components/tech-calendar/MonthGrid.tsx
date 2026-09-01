'use client';

import { useState } from 'react';

import { getDaysInMonth, getFirstDayOfMonth, toDateStr } from '@/lib/techCalendar/dates';
import { addMoney, emptyTotals, formatMoney, formatTotals } from '@/lib/techCalendar/money';
import { STATUS_LABELS, type TechSubscription } from '@/lib/techCalendar/types';
import { STATUS_STYLES } from '@/components/tech-calendar/statusStyles';

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Props {
  subscriptions: TechSubscription[];
  year: number;
  month: number;
  today: string;
  onSelect: (sub: TechSubscription) => void;
}

function dayTotals(subs: TechSubscription[]) {
  return subs
    .filter((s) => s.status !== 'cancel' && !s.is_hidden)
    .reduce((acc, s) => addMoney(acc, s.currency, s.amount), emptyTotals());
}

export default function MonthGrid({ subscriptions, year, month, today, onSelect }: Props) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  // Попап дня: в клетке помещаются два-три сервиса, а в день переоформления
  // пула прокси их бывает с десяток — итог за день иначе пришлось бы считать
  // глазами.
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDate = new Map<string, TechSubscription[]>();
  for (const sub of subscriptions) {
    const list = byDate.get(sub.next_billing_date) ?? [];
    list.push(sub);
    byDate.set(sub.next_billing_date, list);
  }

  const openSubs = openDay ? (byDate.get(openDay) ?? []) : [];

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
          const subs = byDate.get(dateStr) ?? [];
          const isToday = dateStr === today;
          return (
            <div key={dateStr} className="min-h-24 border-b border-r border-gray-50 p-1.5 align-top">
              <button
                type="button"
                onClick={() => setOpenDay(subs.length ? dateStr : null)}
                className={`mb-1 text-xs ${isToday ? 'font-semibold text-blue-600' : 'text-gray-400'}`}
              >
                {day}
              </button>
              <div className="space-y-1">
                {subs.map((sub) => {
                  const style = STATUS_STYLES[sub.status];
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => onSelect(sub)}
                      className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] ${style.bg} ${style.text} ${sub.is_hidden ? 'opacity-45 line-through' : ''}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <span className="truncate">{sub.service_name}</span>
                      <span className="ml-auto shrink-0">{formatMoney(sub.amount, sub.currency)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {openDay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 p-4" onClick={() => setOpenDay(null)}>
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-900">{openDay}</div>
              <button type="button" onClick={() => setOpenDay(null)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="space-y-1">
              {openSubs.map((sub) => {
                const style = STATUS_STYLES[sub.status];
                return (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => {
                      setOpenDay(null);
                      onSelect(sub);
                    }}
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
              })}
            </div>
            <div className="mt-3 border-t border-gray-100 pt-2 text-sm font-medium text-gray-900">
              Итого: {formatTotals(dayTotals(openSubs)).join(' · ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
