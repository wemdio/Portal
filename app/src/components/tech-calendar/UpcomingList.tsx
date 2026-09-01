'use client';

import { daysUntil } from '@/lib/techCalendar/dates';
import { formatMoney } from '@/lib/techCalendar/money';
import { upcoming } from '@/lib/techCalendar/stats';
import { SERVICE_TYPE_LABELS, STATUS_LABELS, type TechSubscription } from '@/lib/techCalendar/types';
import { STATUS_STYLES } from '@/components/tech-calendar/statusStyles';

interface Props {
  subscriptions: TechSubscription[];
  today: string;
  onRenew: (sub: TechSubscription) => void;
  onDecide: (sub: TechSubscription, decision: 'keep' | 'cancel') => void;
}

function whenLabel(dateStr: string, today: string): string {
  const d = daysUntil(dateStr, today);
  if (d < 0) return `просрочено на ${Math.abs(d)} дн.`;
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  return `через ${d} дн.`;
}

export default function UpcomingList({ subscriptions, today, onRenew, onDecide }: Props) {
  const items = upcoming(subscriptions, today);
  if (!items.length) return null;

  return (
    <div className="rounded-xl border border-gray-100 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Ближайшие 7 дней</h2>
        <p className="mt-0.5 text-xs text-gray-500">Сервисы, по которым скоро списание</p>
      </div>
      <div className="divide-y divide-gray-50">
        {items.map((sub) => {
          const style = STATUS_STYLES[sub.status];
          const daysToBilling = daysUntil(sub.next_billing_date, today);
          const isAccepted = sub.status === 'keep';
          const canRenew = isAccepted && daysToBilling <= 0;
          const canKeep = !isAccepted;
          const canCancel = !isAccepted || daysToBilling > 0;
          return (
            <div key={sub.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-900">{sub.service_name}</div>
                <div className="text-xs text-gray-500">
                  {SERVICE_TYPE_LABELS[sub.service_type]} · {sub.next_billing_date} · {whenLabel(sub.next_billing_date, today)}
                </div>
              </div>
              <div className="text-sm font-medium text-gray-900">{formatMoney(sub.amount, sub.currency)}</div>
              <span className={`rounded px-2 py-1 text-xs ${style.bg} ${style.text}`}>{STATUS_LABELS[sub.status]}</span>
              <div className="flex gap-2">
                {canRenew && (
                  <button
                    type="button"
                    onClick={() => onRenew(sub)}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700"
                  >
                    Оплачено — продлить
                  </button>
                )}
                {canKeep && (
                  <button
                    type="button"
                    onClick={() => onDecide(sub, 'keep')}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    Оставить
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    onClick={() => onDecide(sub, 'cancel')}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    Отменить
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
