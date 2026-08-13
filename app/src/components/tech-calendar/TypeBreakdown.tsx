'use client';

import { formatTotals } from '@/lib/techCalendar/money';
import { totalsByType } from '@/lib/techCalendar/stats';
import { SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType, type TechSubscription } from '@/lib/techCalendar/types';

interface Props {
  subscriptions: TechSubscription[];
  year: number;
  month: number;
  selected: ServiceType | null;
  onSelect: (type: ServiceType | null) => void;
}

export default function TypeBreakdown({ subscriptions, year, month, selected, onSelect }: Props) {
  const totals = totalsByType(subscriptions, year, month);

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`rounded-lg border px-3 py-2 text-sm ${selected === null ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'}`}
      >
        Все типы
      </button>
      {SERVICE_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => onSelect(selected === type ? null : type)}
          className={`rounded-lg border px-3 py-2 text-left text-sm ${selected === type ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'}`}
        >
          <div>{SERVICE_TYPE_LABELS[type]}</div>
          <div className="text-xs text-gray-500">{formatTotals(totals[type]).join(' · ')}</div>
        </button>
      ))}
    </div>
  );
}
