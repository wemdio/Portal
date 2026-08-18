'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PaymentLimitSummary from '@/components/payments/PaymentLimitSummary';
import PaymentRequestForm from '@/components/payments/PaymentRequestForm';
import PaymentRequestList from '@/components/payments/PaymentRequestList';
import { formatRubles, PAYMENT_DEPARTMENT_LABELS } from '@/components/payments/format';
import { currentMoscowDate } from '@/lib/calendarDate';
import {
  loadPayments,
  newIdempotencyKey,
  submitPaymentRequest,
  updatePaymentRequest,
} from '@/lib/payments/client';
import { paymentRequestBelongsToMonth } from '@/lib/payments/monthMembership';
import type {
  PaymentRequest,
  PaymentRequestActionInput,
  PaymentRequestActionResponse,
  PaymentsReadModel,
  SubmitPaymentRequestInput,
  SubmitPaymentRequestResponse,
} from '@/lib/payments/types';

type PaymentsTab = 'requests' | 'stats';

function currentMonthKey(): string {
  return currentMoscowDate().slice(0, 7);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось загрузить расходы';
}

function PaymentStatistics({ model }: { model: PaymentsReadModel }) {
  const departmentRows = useMemo(() => {
    const totals = new Map<string, { count: number; amount: number }>();
    for (const request of model.requests) {
      if (request.status !== 'paid' || request.paidOn?.slice(0, 7) !== model.period.key) continue;
      const current = totals.get(request.department) ?? { count: 0, amount: 0 };
      totals.set(request.department, {
        count: current.count + 1,
        amount: current.amount + request.amount,
      });
    }
    return [...totals.entries()].sort((left, right) => right[1].amount - left[1].amount);
  }, [model.period.key, model.requests]);

  return (
    <section role="tabpanel" id="payments-stats-panel" aria-labelledby="payments-stats-tab" className="border border-gray-200 bg-white">
      <div className="grid grid-cols-2 divide-x divide-y divide-gray-200 sm:grid-cols-4 sm:divide-y-0">
        <div className="px-4 py-3"><p className="text-xs text-gray-500">Оплачено всего</p><p className="mt-1 font-semibold tabular-nums">{formatRubles(model.summary.paidAll)}</p></div>
        <div className="px-4 py-3"><p className="text-xs text-gray-500">На согласовании</p><p className="mt-1 font-semibold tabular-nums">{model.summary.pendingCount}</p></div>
        <div className="px-4 py-3"><p className="text-xs text-gray-500">Одобрено</p><p className="mt-1 font-semibold tabular-nums">{model.summary.approvedCount}</p></div>
        <div className="px-4 py-3"><p className="text-xs text-gray-500">Записей</p><p className="mt-1 font-semibold tabular-nums">{model.requests.length}</p></div>
      </div>
      <div className="max-w-full overflow-x-auto border-t border-gray-200">
        <table className="min-w-full text-sm" aria-label={`Оплаченные расходы по отделам за ${model.period.label}`}>
          <thead className="bg-gray-50 text-left text-xs text-gray-600"><tr><th className="px-4 py-3 font-medium">Отдел</th><th className="px-4 py-3 text-right font-medium">Оплат</th><th className="px-4 py-3 text-right font-medium">Сумма</th></tr></thead>
          <tbody className="divide-y divide-gray-200">
            {departmentRows.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-500">В этом периоде нет оплаченных расходов</td></tr>
            ) : departmentRows.map(([department, values]) => (
              <tr key={department}>
                <td className="px-4 py-3 text-gray-900">{PAYMENT_DEPARTMENT_LABELS[department] || department}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-700">{values.count}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-gray-900">{formatRubles(values.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PaymentsPageView() {
  const [month, setMonth] = useState(currentMonthKey);
  const [model, setModel] = useState<PaymentsReadModel | null>(null);
  const [activeTab, setActiveTab] = useState<PaymentsTab>('requests');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitFeedback, setSubmitFeedback] = useState('');
  const [actionFeedback, setActionFeedback] = useState<{ requestId: string; message: string } | null>(null);
  const [submittingExpense, setSubmittingExpense] = useState(false);
  const [hasOpenActionDraft, setHasOpenActionDraft] = useState(false);
  const activeLoadRef = useRef<AbortController | null>(null);
  const loadErrorRef = useRef<HTMLDivElement>(null);
  const submissionKeyRef = useRef<{ signature: string; key: string } | null>(null);

  const load = useCallback(async (targetMonth: string) => {
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    setLoading(true);
    setLoadError('');

    try {
      const nextModel = await loadPayments(targetMonth, controller.signal);
      if (!controller.signal.aborted && activeLoadRef.current === controller) {
        setModel(nextModel);
        return nextModel;
      }
      return null;
    } catch (error) {
      if (!controller.signal.aborted && activeLoadRef.current === controller) {
        setLoadError(messageFromError(error));
      }
      return null;
    } finally {
      if (!controller.signal.aborted && activeLoadRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const start = window.setTimeout(() => void load(month), 0);
    return () => {
      window.clearTimeout(start);
      activeLoadRef.current?.abort();
    };
  }, [load, month]);

  useEffect(() => {
    if (loadError) loadErrorRef.current?.focus();
  }, [loadError]);

  const submit = useCallback(async (
    input: SubmitPaymentRequestInput,
  ): Promise<SubmitPaymentRequestResponse> => {
    setSubmitFeedback('');
    // Повтор той же заявки (потерянный ответ, двойной клик) идёт с тем же
    // ключом и лишь перечитывает созданный расход. Изменённый черновик —
    // это уже другая заявка, поэтому получает новый ключ.
    const signature = JSON.stringify(input);
    const pending = submissionKeyRef.current;
    const idempotencyKey = pending?.signature === signature ? pending.key : newIdempotencyKey();
    submissionKeyRef.current = { signature, key: idempotencyKey };
    const result = await submitPaymentRequest(input, idempotencyKey);
    submissionKeyRef.current = null;
    setSubmitFeedback(result.outcome === 'auto_approved'
      ? 'Расход одобрен автоматически.'
      : 'Расход отправлен Ане на согласование.');
    const targetMonth = input.expectedPaymentOn.slice(0, 7);
    if (model && targetMonth !== model.period.key) {
      setModel(null);
      setMonth(targetMonth);
    } else {
      setModel((current) => current ? {
        ...current,
        summary: result.summary,
        requests: [result.request, ...current.requests.filter((request) => request.id !== result.request.id)],
      } : current);
    }
    return result;
  }, [model]);

  const refreshRequest = useCallback(async (id: string): Promise<PaymentRequest | null> => {
    const refreshed = await load(model?.period.key ?? month);
    return refreshed?.requests.find((request) => request.id === id) ?? null;
  }, [load, model?.period.key, month]);

  const actOnRequest = useCallback(async (
    id: string,
    input: PaymentRequestActionInput,
  ): Promise<PaymentRequestActionResponse> => {
    const result = await updatePaymentRequest(id, input);
    const feedbackByOutcome: Record<PaymentRequestActionResponse['outcome'], string> = {
      approved: 'Расход одобрен.',
      rejected: 'Расход отклонён.',
      paid: 'Расход отмечен оплаченным.',
      legacy_classified: 'Тип и дата старого расхода уточнены.',
    };
    setModel((current) => {
      if (!current) return current;
      const currentSummary = result.summaries.find(({ month: affectedMonth }) => (
        affectedMonth === current.period.key
      ));
      return {
        ...current,
        summary: currentSummary?.summary ?? current.summary,
        requests: paymentRequestBelongsToMonth(result.request, current.period.key)
          ? current.requests.map((request) => (
            request.id === result.request.id ? result.request : request
          ))
          : current.requests.filter((request) => request.id !== result.request.id),
      };
    });
    setActionFeedback({ requestId: result.request.id, message: feedbackByOutcome[result.outcome] });
    return result;
  }, []);

  const navigationLocked = submittingExpense || hasOpenActionDraft;

  return (
    <main
      role="region"
      aria-label="Оплаты"
      aria-busy={loading}
      className="min-h-screen bg-white px-4 py-5 text-gray-900 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-[1440px] space-y-5">
        <header className="flex flex-col gap-4 border-b border-gray-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Оплаты</h1>
            <p className="mt-1 text-sm text-gray-500">Разовые и плановые расходы компании</p>
          </div>
          <div role="tablist" aria-label="Разделы оплат" className="inline-flex min-h-11 max-w-full w-fit gap-1 overflow-x-auto border border-gray-200 bg-white p-1">
            <button
              id="payments-requests-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === 'requests'}
              aria-controls="payments-requests-panel"
              disabled={navigationLocked && activeTab !== 'requests'}
              onClick={() => setActiveTab('requests')}
              className={`min-h-10 px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${activeTab === 'requests' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >Расходы</button>
            <button
              id="payments-stats-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === 'stats'}
              aria-controls="payments-stats-panel"
              disabled={navigationLocked && activeTab !== 'stats'}
              onClick={() => setActiveTab('stats')}
              className={`min-h-10 px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${activeTab === 'stats' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >Статистика</button>
          </div>
        </header>

        {submitFeedback && <p role="status" aria-live="polite" className="sr-only">{submitFeedback}</p>}

        {loading && !model && (
          <div role="status" aria-label="Загрузка расходов" className="border border-gray-200 px-4 py-12 text-center text-sm text-gray-500">Загружаем расходы…</div>
        )}

        {loadError && (
          <div ref={loadErrorRef} role="alert" tabIndex={-1} className="border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 outline-none">
            <p className="font-medium">{loadError}</p>
            <button type="button" onClick={() => void load(month)} className="mt-3 min-h-11 border border-red-300 bg-white px-4 font-semibold outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500">Повторить</button>
          </div>
        )}

        {model && (
          <>
            <div className="flex items-center justify-between gap-3 border border-gray-200 bg-white px-3 py-2">
              <button type="button" aria-label="Предыдущий месяц" disabled={navigationLocked} onClick={() => setMonth(model.period.previous)} className="min-h-11 min-w-11 border border-gray-200 text-lg outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">←</button>
              <div className="text-center"><p className="font-semibold text-gray-900">{model.period.label}</p><p className="mt-0.5 text-xs text-gray-500">Данные на {model.period.asOf}</p></div>
              <button type="button" aria-label="Следующий месяц" disabled={navigationLocked} onClick={() => setMonth(model.period.next)} className="min-h-11 min-w-11 border border-gray-200 text-lg outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">→</button>
            </div>

            <PaymentLimitSummary summary={model.summary} canManage={model.canManage} />

            <div
              role="tabpanel"
              id="payments-requests-panel"
              aria-labelledby="payments-requests-tab"
              hidden={activeTab !== 'requests'}
              className="space-y-5"
            >
                <PaymentRequestForm
                  projects={model.projects}
                  summary={model.summary}
                  periodKey={model.period.key}
                  onSubmittingChange={setSubmittingExpense}
                  onSubmit={submit}
                />
                {actionFeedback && <p role="status" aria-live="polite" className="sr-only">{actionFeedback.message}</p>}
                <PaymentRequestList
                  periodLabel={model.period.label}
                  asOf={model.period.asOf}
                  requests={model.requests}
                  canManage={model.canManage}
                  focusRequestId={actionFeedback?.requestId ?? null}
                  onActionDraftOpenChange={setHasOpenActionDraft}
                  onRefreshRequest={refreshRequest}
                  onAction={actOnRequest}
                />
            </div>
            {activeTab === 'stats' && <PaymentStatistics model={model} />}
          </>
        )}
      </div>
    </main>
  );
}
