'use client';

import { formatTotals } from '@/lib/techCalendar/money';
import { activeCount, decisionsDueWithin, monthTotals, pendingCount } from '@/lib/techCalendar/stats';
import type { TechSubscription } from '@/lib/techCalendar/types';

interface Props {
  subscriptions: TechSubscription[];
  year: number;
  month: number;
  today: string;
}

function Card({ label, values, accent }: { label: string; values: string[]; accent?: 'amber' | 'blue' }) {
  const color = accent === 'amber' ? 'text-amber-600' : accent === 'blue' ? 'text-blue-600' : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 space-y-0.5 text-2xl font-semibold ${color}`}>
        {values.map((v) => (
          <div key={v}>{v}</div>
        ))}
      </div>
    </div>
  );
}

export default function StatsRow({ subscriptions, year, month, today }: Props) {
  const pending = pendingCount(subscriptions);
  const due = decisionsDueWithin(subscriptions, today);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Активных сервисов" values={[String(activeCount(subscriptions))]} />
      <Card label="Ожидают решения" values={[String(pending)]} accent={pending ? 'amber' : undefined} />
      <Card label="За этот месяц" values={formatTotals(monthTotals(subscriptions, year, month))} />
      <Card label="Решений на 7 дней" values={[String(due)]} accent={due ? 'blue' : undefined} />
    </div>
  );
}
