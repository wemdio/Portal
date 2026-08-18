'use client';

import { useEffect, useRef, useState } from 'react';

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

const STATUS_META: Record<PaymentRequest['status'], { label: string; className: string; dotClassName: string }> = {
  pending: { label: 'На согласовании', className: 'text-amber-800', dotClassName: 'bg-amber-500' },
  approved: { label: 'Одобрено', className: 'text-emerald-700', dotClassName: 'bg-emerald-500' },
  paid: { label: 'Оплачено', className: 'text-blue-700', dotClassName: 'bg-blue-500' },
  rejected: { label: 'Отклонено', className: 'text-red-700', dotClassName: 'bg-red-500' },
};

const EXPENSE_TYPE_LABELS: Record<PaymentRequest['expenseType'], string> = {
  one_time: 'Разовый',
  planned: 'Плановый',
  legacy_unclassified: 'Тип не определён',
};

const URGENCY_LABELS: Record<PaymentRequest['urgency'], string> = {
  normal: 'Обычная',
  urgent: 'Высокая',
  critical: 'Критическая',
};

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
  const headingRef = useRef<HTMLHeadingElement>(null);

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
    <section className="border border-gray-200 bg-white">
      <div className="flex flex-col gap-1 border-b border-gray-200 px-4 py-3 sm:flex-row sm:items-end sm:justify-between sm:px-5">
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="font-semibold text-gray-900 outline-none">Расходы за период</h2>
          <p className="mt-1 text-xs text-gray-500">{requests.length} записей · статусы и лимит вычислены сервером</p>
        </div>
        {canManage && <p className="text-xs font-medium text-gray-600">Режим согласования</p>}
      </div>

      <div
        role="region"
        aria-label="Список расходов"
        tabIndex={0}
        className="max-w-full overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        <table aria-label={`Расходы за ${periodLabel}`} className="min-w-[1120px] w-full border-collapse text-left text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Расход</th>
              <th scope="col" className="px-4 py-3 font-medium">Сотрудник</th>
              <th scope="col" className="px-4 py-3 font-medium">Тип и срочность</th>
              <th scope="col" className="px-4 py-3 font-medium">Дата</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Сумма</th>
              <th scope="col" className="px-4 py-3 font-medium">Статус</th>
              {canManage && <th scope="col" className="px-4 py-3 text-right font-medium">Действия</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {requests.length === 0 ? (
              <tr><td colSpan={canManage ? 7 : 6} className="px-4 py-10 text-center text-gray-500">За этот период расходов нет</td></tr>
            ) : requests.map((request) => {
              const status = STATUS_META[request.status];
              return (
                <tr id={`payment-request-${request.id}`} key={request.id} tabIndex={-1} className="align-top outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
                  <td className="max-w-sm px-4 py-3">
                    <p className="font-medium text-gray-900">{request.description}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {PAYMENT_DEPARTMENT_LABELS[request.department] || request.department}
                      {request.project ? ` · ${formatTeamProjectLabel(request.project.client, request.project.name)}` : ''}
                    </p>
                    {request.comment && <p className="mt-2 text-xs leading-5 text-gray-600">{request.comment}</p>}
                    {request.documentUrl && (
                      <a
                        href={request.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Открыть документ для ${request.description}`}
                        className="mt-2 inline-flex min-h-10 items-center text-xs font-semibold text-blue-700 underline decoration-blue-300 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        Открыть документ
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-800">{request.requester.name}</td>
                  <td className="px-4 py-3">
                    <p className={request.expenseType === 'legacy_unclassified' ? 'font-medium text-amber-800' : 'text-gray-800'}>
                      {EXPENSE_TYPE_LABELS[request.expenseType]}
                    </p>
                    {request.expenseType === 'legacy_unclassified' && <p className="mt-1 text-xs text-amber-700">Старые данные</p>}
                    <p className={request.urgency === 'critical' ? 'mt-1 text-xs font-semibold text-red-700' : 'mt-1 text-xs text-gray-500'}>
                      {URGENCY_LABELS[request.urgency]}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                    <p>{formatPaymentDate(request.expectedPaymentOn)}</p>
                    {request.status === 'paid' && <p className="mt-1 text-xs text-gray-500">Факт: {formatPaymentDate(request.paidOn)}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{formatRubles(request.amount)}</td>
                  <td className={`whitespace-nowrap px-4 py-3 font-semibold ${status.className}`}>
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
                      {status.label}
                    </span>
                    {request.approvalReason === 'planned' && <p className="mt-1 text-xs font-normal text-gray-500">Плановый</p>}
                    {request.approvalReason === 'limit_exceeded' && <p className="mt-1 text-xs font-normal text-gray-500">Сверх лимита</p>}
                    {request.decisionComment && <p className="mt-1 max-w-48 whitespace-normal text-xs font-normal text-gray-600">{request.decisionComment}</p>}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <PaymentRequestActions
                        request={request}
                        asOf={asOf}
                        disabled={activeRequestId !== null && activeRequestId !== request.id}
                        onDraftOpenChange={(open) => handleDraftOpenChange(request.id, open)}
                        onRefreshRequest={onRefreshRequest}
                        onAction={onAction}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
