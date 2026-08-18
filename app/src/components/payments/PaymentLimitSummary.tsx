import type { PaymentMonthSummary } from '@/lib/payments/types';

import { formatRubles } from './format';

interface PaymentLimitSummaryProps {
  summary: PaymentMonthSummary;
  canManage: boolean;
}

function legacyCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 19) return `${count} старых записей`;
  if (mod10 === 1) return `${count} старая запись`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} старые записи`;
  return `${count} старых записей`;
}

export default function PaymentLimitSummary({ summary, canManage }: PaymentLimitSummaryProps) {
  const remainingPercent = summary.limit > 0
    ? Math.max(0, Math.round((summary.remaining / summary.limit) * 100))
    : 0;
  const progress = Math.min(100, Math.max(0, summary.usagePct));
  const progressTone = summary.level === 'exceeded'
    ? 'bg-red-500'
    : summary.level === 'warning'
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  return (
    <div className="space-y-3">
      {summary.legacyCount > 0 && (
        <aside
          role="note"
          aria-label="Неполные данные"
          className="border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          <p className="font-semibold">Неполные данные: {legacyCountLabel(summary.legacyCount)} на {formatRubles(summary.legacyAmount)}</p>
          <p className="mt-1 leading-5">
            Они временно учтены как разовые и оплаченные по дате создания.
            {canManage ? ' Уточните тип и фактическую дату в списке ниже.' : ''}
          </p>
        </aside>
      )}

      <section
        role="region"
        aria-label="Лимит разовых расходов"
        className="border border-gray-200 bg-white"
      >
        <div className="grid grid-cols-2 divide-x divide-y divide-gray-200 sm:grid-cols-4 sm:divide-y-0">
          {[
            ['Лимит', summary.limit],
            ['Оплачено', summary.paidOneTime],
            ['Зарезервировано', summary.reservedOneTime],
            ['Доступно', Math.max(0, summary.remaining)],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0 px-4 py-3">
              <p className="text-xs font-medium text-gray-500">{label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                {formatRubles(Number(value))}
              </p>
            </div>
          ))}
        </div>
        <div className="border-t border-gray-200 px-4 py-3">
          <div
            role="progressbar"
            aria-label="Использовано лимита"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            className="h-2 overflow-hidden rounded-full bg-gray-100"
          >
            <div className={`h-full ${progressTone}`} style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
            <p className="text-gray-600">Лимит общий для компании. Плановые расходы в него не входят.</p>
            {summary.level === 'exceeded' ? (
              <p className="font-semibold text-red-700">Лимит превышен на {formatRubles(summary.overage)}</p>
            ) : summary.level === 'warning' ? (
              <p className="font-semibold text-amber-700">Осталось {remainingPercent}% месячного лимита</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
