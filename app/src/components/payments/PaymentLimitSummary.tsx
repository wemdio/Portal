import { AlertTriangle } from 'lucide-react';

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
  const plannedPaid = Math.max(0, summary.paidAll - summary.paidOneTime - summary.costBudget.paid);
  const progress = Math.min(100, Math.max(0, summary.usagePct));
  const progressTone = summary.level === 'exceeded'
    ? 'bg-red-500'
    : summary.level === 'warning'
      ? 'bg-amber-500'
      : 'bg-emerald-500';
  const limitState = summary.level === 'exceeded'
    ? `Лимит превышен на ${formatRubles(summary.overage)}`
    : summary.level === 'warning'
      ? `Осталось ${remainingPercent}% месячного лимита`
      : `Свободно ${remainingPercent}%`;
  const limitStateClass = summary.level === 'exceeded'
    ? 'bg-red-50 text-red-700 ring-red-200'
    : summary.level === 'warning'
      ? 'bg-amber-50 text-amber-800 ring-amber-200'
      : 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  const costProgress = Math.min(100, Math.max(0, summary.costBudget.usagePct));
  const costProgressTone = !summary.costBudget.dataComplete
    ? 'bg-amber-500'
    : summary.costBudget.level === 'exceeded'
    ? 'bg-red-500'
    : summary.costBudget.level === 'warning'
      ? 'bg-amber-500'
      : 'bg-blue-500';
  const costState = !summary.costBudget.dataComplete
    ? 'Данные неполные'
    : summary.costBudget.level === 'exceeded'
    ? `Превышение ${formatRubles(summary.costBudget.overage)}`
    : `Доступно ${formatRubles(Math.max(0, summary.costBudget.remaining))}`;
  const categoryLabels = {
    instantly: 'Instantly',
    email: 'Почты',
    bases: 'Базы',
    domains: 'Домены',
    other: 'Другое',
  } as const;

  return (
    <section
      role="region"
      aria-label="Сводка расходов"
      className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.65fr)]">
        <div className="border-b border-gray-200 px-5 py-5 sm:px-6 sm:py-6 lg:border-b-0 lg:border-r">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Факт за месяц</p>
          <h2 className="mt-2 text-sm font-medium text-gray-700">Всего оплачено</h2>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-gray-950">
            {formatRubles(summary.paidAll)}
          </p>
          <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-gray-100 pt-4">
            <div>
              <dt className="text-xs text-gray-500">Разовые</dt>
              <dd className="mt-1 font-semibold tabular-nums text-gray-900">{formatRubles(summary.paidOneTime)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Плановые</dt>
              <dd className="mt-1 font-semibold tabular-nums text-gray-900">{formatRubles(plannedPaid)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Косты</dt>
              <dd className="mt-1 font-semibold tabular-nums text-gray-900">{formatRubles(summary.costBudget.paid)}</dd>
            </div>
          </dl>
        </div>

        <section
          role="region"
          aria-label="Лимит разовых расходов"
          className="px-5 py-5 sm:px-6 sm:py-6"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Контроль бюджета</p>
              <h2 className="mt-2 text-lg font-semibold text-gray-950">Лимит разовых расходов</h2>
            </div>
            <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${limitStateClass}`}>
              {limitState}
            </span>
          </div>

          <div
            role="progressbar"
            aria-label="Использовано лимита"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            aria-valuetext={limitState}
            className="mt-5 h-2.5 overflow-hidden rounded-full bg-gray-100"
          >
            <div className={`h-full rounded-full ${progressTone}`} style={{ width: `${progress}%` }} />
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
            {[
              ['Лимит', summary.limit],
              ['Оплачено разовых', summary.paidOneTime],
              ['В резерве', summary.reservedOneTime],
              ['Доступно', Math.max(0, summary.remaining)],
            ].map(([label, value]) => (
              <div key={String(label)} className="min-w-0">
                <dt className="text-xs text-gray-500">{label}</dt>
                <dd className="mt-1 text-base font-semibold tabular-nums text-gray-950">
                  {formatRubles(Number(value))}
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-5 border-t border-gray-100 pt-4 text-xs leading-5 text-gray-500">
            Лимит общий для компании. Плановые расходы в него не входят.
          </p>
        </section>
      </div>

      <section
        role="region"
        aria-label="Лимит костов"
        className="border-t border-gray-200 px-5 py-5 sm:px-6 sm:py-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Косты компании</p>
            <h2 className="mt-2 text-lg font-semibold text-gray-950">Instantly, почты, базы, домены и другое</h2>
            <p className="mt-1 text-sm leading-5 text-gray-500">
              Календарь почт попадает в «Почты», календарь технички в «Другое». «Оставить» до даты списания считается резервом, затем фактом.
            </p>
          </div>
          <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${
            !summary.costBudget.dataComplete
              ? 'bg-amber-50 text-amber-800 ring-amber-200'
              : summary.costBudget.level === 'exceeded'
              ? 'bg-red-50 text-red-700 ring-red-200'
              : summary.costBudget.level === 'warning'
                ? 'bg-amber-50 text-amber-800 ring-amber-200'
                : 'bg-blue-50 text-blue-700 ring-blue-200'
          }`}>
            {costState}
          </span>
        </div>

        <div
          role="progressbar"
          aria-label="Использовано лимита костов"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(costProgress)}
          aria-valuetext={costState}
          className="mt-5 h-2.5 overflow-hidden rounded-full bg-gray-100"
        >
          <div className={`h-full rounded-full ${costProgressTone}`} style={{ width: `${costProgress}%` }} />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
          {[
            ['Лимит', summary.costBudget.limit],
            ['Оплачено', summary.costBudget.paid],
            ['В резерве', summary.costBudget.reserved],
            ['Доступно', Math.max(0, summary.costBudget.remaining)],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0">
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-gray-950">
                {label === 'Доступно' && !summary.costBudget.dataComplete
                  ? '—'
                  : formatRubles(Number(value))}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 border-t border-gray-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">По категориям, факт + резерв</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-5">
            {Object.entries(summary.costBudget.byCategory).map(([category, totals]) => (
              <div key={category}>
                <dt className="text-xs text-gray-500">{categoryLabels[category as keyof typeof categoryLabels]}</dt>
                <dd className="mt-1 font-semibold tabular-nums text-gray-900">
                  {formatRubles(totals.paid + totals.reserved)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 grid gap-1 text-xs leading-5 text-gray-500 sm:grid-cols-2 sm:gap-x-5">
            <p>
              {`Календарь почт: оплачено ${formatRubles(summary.costBudget.mailPaid)}, резерв ${formatRubles(summary.costBudget.mailReserved)}.`}
            </p>
            <p>
              {`Календарь технички: оплачено ${formatRubles(summary.costBudget.techPaid)}, резерв ${formatRubles(summary.costBudget.techReserved)}.`}
            </p>
          </div>
        </div>
      </section>

      {!summary.costBudget.dataComplete && (
        <aside
          role="alert"
          className="flex items-start gap-3 border-t border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950 sm:px-6"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <p>
            {`Не удалось пересчитать ${summary.costBudget.missingFxCount} платеж(а) из календарей в рубли. До обновления курса новые косты заблокированы, чтобы не превысить лимит незаметно.`}
          </p>
        </aside>
      )}

      {summary.legacyCount > 0 && (
        <aside
          role="note"
          aria-label="Неполные данные"
          className="flex items-start gap-3 border-t border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950 sm:px-6"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">
              Требуют уточнения: {legacyCountLabel(summary.legacyCount)} на {formatRubles(summary.legacyAmount)}
            </p>
            <p className="mt-1 leading-5 text-amber-900">
              Они временно учтены как разовые и оплаченные по дате создания.
              {canManage ? ' Уточните тип и фактическую дату в списке ниже.' : ''}
            </p>
          </div>
        </aside>
      )}
    </section>
  );
}
