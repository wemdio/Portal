'use client';

import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  PaymentRequest,
  PaymentRequestActionInput,
  PaymentRequestActionResponse,
} from '@/lib/payments/types';
import { formatTeamProjectLabel } from '@/lib/teamProjectLabel';

import { formatPaymentDate, formatRubles, PAYMENT_DEPARTMENT_LABELS } from './format';
import PaymentRequestActions from './PaymentRequestActions';

interface PaymentRequestListProps {
  periodLabel: string;
  asOf: string;
  requests: PaymentRequest[];
  canManage: boolean;
  focusRequestId?: string | null;
  onActionDraftOpenChange?: (open: boolean) => void;
  onRefreshRequest: (id: string) => Promise<PaymentRequest | null>;
  onAction: (
    id: string,
    input: PaymentRequestActionInput,
  ) => Promise<PaymentRequestActionResponse>;
}

const STATUS_META: Record<PaymentRequest['status'], {
  label: string;
  className: string;
  dotClassName: string;
}> = {
  pending: {
    label: 'На согласовании',
    className: 'bg-amber-50 text-amber-800 ring-amber-200',
    dotClassName: 'bg-amber-500',
  },
  approved: {
    label: 'Одобрено',
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dotClassName: 'bg-emerald-500',
  },
  paid: {
    label: 'Оплачено',
    className: 'bg-blue-50 text-blue-700 ring-blue-200',
    dotClassName: 'bg-blue-500',
  },
  rejected: {
    label: 'Отклонено',
    className: 'bg-red-50 text-red-700 ring-red-200',
    dotClassName: 'bg-red-500',
  },
};

const EXPENSE_TYPE_LABELS: Record<PaymentRequest['expenseType'], string> = {
  one_time: 'Разовый',
  planned: 'Плановый',
  legacy_unclassified: 'Тип не определён',
};

const COST_CATEGORY_LABELS: Record<NonNullable<PaymentRequest['costCategory']>, string> = {
  instantly: 'Instantly',
  email: 'Почты',
  bases: 'Базы',
  domains: 'Домены',
  other: 'Другое',
};

const URGENCY_LABELS: Record<PaymentRequest['urgency'], string> = {
  normal: 'Обычная',
  urgent: 'Высокая',
  critical: 'Критическая',
};

type StatusFilter = 'all' | PaymentRequest['status'];
type ExpenseTypeFilter = 'all' | PaymentRequest['expenseType'] | 'costs';

const filterClass = 'min-h-11 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition-colors hover:border-gray-300 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-100';

export default function PaymentRequestList({
  periodLabel,
  asOf,
  requests,
  canManage,
  focusRequestId = null,
  onActionDraftOpenChange,
  onRefreshRequest,
  onAction,
}: PaymentRequestListProps) {
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expenseTypeFilter, setExpenseTypeFilter] = useState<ExpenseTypeFilter>('all');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const visibleRequests = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ru');
    return requests.filter((request) => {
      if (statusFilter !== 'all' && request.status !== statusFilter) return false;
      if (expenseTypeFilter === 'costs' && request.budgetScope !== 'costs') return false;
      if (
        expenseTypeFilter !== 'all'
        && expenseTypeFilter !== 'costs'
        && (request.budgetScope === 'costs' || request.expenseType !== expenseTypeFilter)
      ) return false;
      if (!normalizedQuery) return true;

      const projectLabel = request.project
        ? formatTeamProjectLabel(request.project.client, request.project.name)
        : '';
      const searchable = [
        request.description,
        request.requester.name,
        PAYMENT_DEPARTMENT_LABELS[request.department] || request.department,
        projectLabel,
        request.comment || '',
        String(request.amount),
      ].join(' ').toLocaleLowerCase('ru');
      return searchable.includes(normalizedQuery);
    });
  }, [expenseTypeFilter, query, requests, statusFilter]);

  useEffect(() => {
    if (!focusRequestId) return;
    const updatedRow = document.getElementById(`payment-request-${focusRequestId}`);
    (updatedRow ?? headingRef.current)?.focus();
  }, [focusRequestId, requests]);

  function handleDraftOpenChange(requestId: string, open: boolean) {
    setActiveRequestId((current) => (
      open ? requestId : current === requestId ? null : current
    ));
    onActionDraftOpenChange?.(open);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">История месяца</p>
          <h2 ref={headingRef} tabIndex={-1} className="mt-1 text-lg font-semibold text-gray-950 outline-none">
            Расходы за период
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {visibleRequests.length === requests.length
              ? `${requests.length} записей`
              : `Показано ${visibleRequests.length} из ${requests.length}`}
          </p>
        </div>
        {canManage && (
          <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
            Доступно согласование
          </span>
        )}
      </div>

      <div
        role="region"
        aria-label="Список расходов"
        className="outline-none"
      >
        <div className="grid gap-3 border-b border-gray-100 bg-gray-50 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px_180px] sm:px-6">
          <label className="relative block">
            <span className="sr-only">Поиск расходов</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-gray-400" />
            <input
              type="search"
              aria-label="Поиск расходов"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Расход, сотрудник или проект"
              className={`${filterClass} w-full pl-9`}
            />
          </label>
          <label>
            <span className="sr-only">Фильтр по статусу</span>
            <select
              aria-label="Фильтр по статусу"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className={`${filterClass} w-full`}
            >
              <option value="all">Все статусы</option>
              <option value="pending">На согласовании</option>
              <option value="approved">Одобрено / в плане</option>
              <option value="paid">Оплачено</option>
              <option value="rejected">Отклонено</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Фильтр по типу</span>
            <select
              aria-label="Фильтр по типу"
              value={expenseTypeFilter}
              onChange={(event) => setExpenseTypeFilter(event.target.value as ExpenseTypeFilter)}
              className={`${filterClass} w-full`}
            >
              <option value="all">Все типы</option>
              <option value="one_time">Разовые</option>
              <option value="planned">Плановые</option>
              <option value="costs">Косты</option>
              <option value="legacy_unclassified">Тип не определён</option>
            </select>
          </label>
        </div>

        <ul aria-label={`Расходы за ${periodLabel}`} className="divide-y divide-gray-100">
          {visibleRequests.length === 0 ? (
            <li className="px-5 py-12 text-center sm:px-6">
              <p className="font-medium text-gray-800">
                {requests.length === 0 ? 'За этот период расходов нет' : 'Ничего не найдено'}
              </p>
              {requests.length > 0 && (
                <p className="mt-1 text-sm text-gray-500">Измените поиск или сбросьте фильтры.</p>
              )}
            </li>
          ) : visibleRequests.map((request) => {
            const status = STATUS_META[request.status];
            return (
              <li
                id={`payment-request-${request.id}`}
                key={request.id}
                data-payment-row
                tabIndex={-1}
                className="px-5 py-5 outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:px-6"
              >
                <div className="grid gap-4 xl:grid-cols-[minmax(280px,1.7fr)_minmax(120px,0.65fr)_minmax(145px,0.75fr)_minmax(120px,0.55fr)_minmax(150px,0.7fr)] xl:items-start">
                  <div className="min-w-0">
                    <p className="font-semibold leading-5 text-gray-950">{request.description}</p>
                    <p className="mt-1.5 text-xs leading-5 text-gray-500">
                      {request.requester.name}
                      {' · '}
                      {PAYMENT_DEPARTMENT_LABELS[request.department] || request.department}
                      {request.project ? ` · ${formatTeamProjectLabel(request.project.client, request.project.name)}` : ''}
                    </p>
                    {request.comment && <p className="mt-2 text-sm leading-5 text-gray-600">{request.comment}</p>}
                    {request.documentUrl && (
                      <a
                        href={request.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Открыть документ для ${request.description}`}
                        className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-blue-700 underline decoration-blue-300 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        Открыть документ
                      </a>
                    )}
                  </div>

                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 xl:sr-only">Тип</p>
                    <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset xl:mt-0 ${
                      request.expenseType === 'legacy_unclassified'
                        ? 'bg-amber-50 text-amber-800 ring-amber-200'
                        : request.budgetScope === 'costs'
                          ? 'bg-blue-50 text-blue-700 ring-blue-200'
                        : 'bg-gray-100 text-gray-700 ring-gray-200'
                    }`}>
                      {request.budgetScope === 'costs'
                        ? `Косты · ${COST_CATEGORY_LABELS[request.costCategory ?? 'other']}`
                        : EXPENSE_TYPE_LABELS[request.expenseType]}
                    </span>
                    {request.expenseType === 'legacy_unclassified' && <p className="mt-1 text-xs text-amber-700">Старые данные</p>}
                    {request.urgency !== 'normal' && (
                      <p className={`mt-2 text-xs font-semibold ${
                        request.urgency === 'critical' ? 'text-red-700' : 'text-amber-700'
                      }`}>
                        Срочность: {URGENCY_LABELS[request.urgency]}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Дата</p>
                    <p className="mt-1 text-sm text-gray-700">{formatPaymentDate(request.expectedPaymentOn)}</p>
                    {request.status === 'paid' && (
                      <p className="mt-1 text-xs text-gray-500">Оплачено: {formatPaymentDate(request.paidOn)}</p>
                    )}
                  </div>

                  <div className="xl:text-right">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Сумма</p>
                    <p className="mt-1 whitespace-nowrap text-base font-semibold tabular-nums text-gray-950">
                      {formatRubles(request.amount)}
                    </p>
                  </div>

                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 xl:sr-only">Статус</p>
                    <span className={`mt-1 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset xl:mt-0 ${status.className}`}>
                      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
                      {request.status === 'approved' && request.autoPaymentOn ? 'Запланировано' : status.label}
                    </span>
                    {request.status === 'approved' && request.autoPaymentOn && (
                      <p className="mt-1 text-xs leading-5 text-gray-500">В резерве. Автоматически в оплаченные {formatPaymentDate(request.autoPaymentOn)}</p>
                    )}
                    {request.approvalReason === 'planned' && <p className="mt-1 text-xs text-gray-500">Плановый</p>}
                    {request.approvalReason === 'limit_exceeded' && <p className="mt-1 text-xs text-gray-500">Сверх лимита</p>}
                    {request.decisionComment && <p className="mt-2 text-xs leading-5 text-gray-600">{request.decisionComment}</p>}
                  </div>
                </div>

                {canManage && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <PaymentRequestActions
                      request={request}
                      asOf={asOf}
                      disabled={activeRequestId !== null && activeRequestId !== request.id}
                      onDraftOpenChange={(open) => handleDraftOpenChange(request.id, open)}
                      onRefreshRequest={onRefreshRequest}
                      onAction={onAction}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
