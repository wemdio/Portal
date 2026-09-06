'use client';

import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PaymentLimitSummary from '@/components/payments/PaymentLimitSummary';
import PaymentRequestForm from '@/components/payments/PaymentRequestForm';
import PaymentRequestList from '@/components/payments/PaymentRequestList';
import { formatPaymentDate, formatRubles, PAYMENT_DEPARTMENT_LABELS } from '@/components/payments/format';
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
    <section
      role="tabpanel"
      id="payments-stats-panel"
      aria-labelledby="payments-stats-tab"
      className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="flex flex-col gap-4 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Структура расходов</p>
          <h2 className="mt-1 text-lg font-semibold text-gray-950">Оплачено по отделам</h2>
          <p className="mt-1 text-sm text-gray-500">Только фактические оплаты за выбранный месяц.</p>
        </div>
        <dl className="flex gap-6">
          <div>
            <dt className="text-xs text-gray-500">Всего оплачено</dt>
            <dd className="mt-1 font-semibold tabular-nums text-gray-950">
              {formatRubles(departmentRows.reduce((sum, [, values]) => sum + values.amount, 0))}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Оплат</dt>
            <dd className="mt-1 font-semibold tabular-nums text-gray-950">
              {departmentRows.reduce((sum, [, values]) => sum + values.count, 0)}
            </dd>
          </div>
        </dl>
      </div>
      <div className="max-w-full overflow-x-auto">
        <table className="min-w-full text-sm" aria-label={`Оплаченные расходы по отделам за ${model.period.label}`}>
          <thead className="bg-gray-50 text-left text-xs text-gray-500"><tr><th className="px-5 py-3 font-medium sm:px-6">Отдел</th><th className="px-4 py-3 text-right font-medium">Оплат</th><th className="px-5 py-3 text-right font-medium sm:px-6">Сумма</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {departmentRows.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-500">В этом периоде нет оплаченных расходов</td></tr>
            ) : departmentRows.map(([department, values]) => (
              <tr key={department}>
                <td className="px-5 py-4 font-medium text-gray-900 sm:px-6">{PAYMENT_DEPARTMENT_LABELS[department] || department}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-700">{values.count}</td>
                <td className="px-5 py-4 text-right font-semibold tabular-nums text-gray-950 sm:px-6">{formatRubles(values.amount)}</td>
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
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitFeedback, setSubmitFeedback] = useState('');
  const [actionFeedback, setActionFeedback] = useState<{ requestId: string; message: string } | null>(null);
  const [submittingExpense, setSubmittingExpense] = useState(false);
  const [hasOpenActionDraft, setHasOpenActionDraft] = useState(false);
  const activeLoadRef = useRef<AbortController | null>(null);
  const loadErrorRef = useRef<HTMLDivElement>(null);
  const submissionKeyRef = useRef<{ signature: string; key: string } | null>(null);
  const mutationInFlightRef = useRef(false);

  const load = useCallback(async (targetMonth: string, background = false) => {
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    if (!background) setLoading(true);
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
      if (!controller.signal.aborted && activeLoadRef.current === controller) {
        setLoading(false);
        activeLoadRef.current = null;
      }
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
    function refreshAtDateChange() {
      if (document.visibilityState !== 'visible' || isFormOpen || hasOpenActionDraft
        || mutationInFlightRef.current || activeLoadRef.current || !model
        || model.period.asOf === currentMoscowDate()) return;
      void load(month, true);
    }
    const timer = window.setInterval(refreshAtDateChange, 30_000);
    window.addEventListener('focus', refreshAtDateChange);
    document.addEventListener('visibilitychange', refreshAtDateChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshAtDateChange);
      document.removeEventListener('visibilitychange', refreshAtDateChange);
    };
  }, [hasOpenActionDraft, isFormOpen, load, model, month]);

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
    activeLoadRef.current?.abort();
    activeLoadRef.current = null;
    mutationInFlightRef.current = true;
    let result: SubmitPaymentRequestResponse;
    try {
      result = await submitPaymentRequest(input, idempotencyKey);
    } finally {
      mutationInFlightRef.current = false;
    }
    submissionKeyRef.current = null;
    setIsFormOpen(false);
    setSubmitFeedback(result.request.status === 'paid'
      ? 'Оплата записана и учтена в фактических расходах.'
      : result.outcome === 'auto_approved'
        ? result.request.autoPaymentOn
          ? `Сумма в резерве. Автоматически учтём оплату ${formatPaymentDate(result.request.autoPaymentOn)}`
          : 'Расход одобрен.'
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
    activeLoadRef.current?.abort();
    activeLoadRef.current = null;
    mutationInFlightRef.current = true;
    let result: PaymentRequestActionResponse;
    try {
      result = await updatePaymentRequest(id, input);
    } finally {
      mutationInFlightRef.current = false;
    }
    const feedbackByOutcome: Record<PaymentRequestActionResponse['outcome'], string> = {
      approved: result.request.autoPaymentOn
        ? `Расход одобрен. Автоматически учтём оплату ${formatPaymentDate(result.request.autoPaymentOn)}`
        : 'Расход одобрен.',
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
  const formVisible = isFormOpen && activeTab === 'requests';

  return (
    <section
      role="region"
      aria-label="Оплаты"
      aria-busy={loading}
      className="bg-gray-50 px-4 py-6 text-gray-900 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-[1280px] space-y-5">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Финансы компании</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-gray-950">Оплаты</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              Фактические расходы, заявки и отдельные лимиты разовых покупок и костов.
            </p>
          </div>
          <button
            type="button"
            aria-expanded={formVisible}
            aria-controls="new-payment-form-panel"
            disabled={!model || navigationLocked}
            onClick={() => {
              if (formVisible) {
                setIsFormOpen(false);
                return;
              }
              setActiveTab('requests');
              setIsFormOpen(true);
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white outline-none transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-300 sm:w-auto"
          >
            {formVisible ? <X aria-hidden="true" className="h-4 w-4" /> : <Plus aria-hidden="true" className="h-4 w-4" />}
            {formVisible ? 'Закрыть форму' : 'Новый расход'}
          </button>
        </header>

        {submitFeedback && (
          <p role="status" aria-live="polite" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            {submitFeedback}
          </p>
        )}

        {loading && !model && (
          <div role="status" aria-label="Загрузка расходов" className="rounded-2xl border border-gray-200 bg-white px-4 py-16 text-center text-sm text-gray-500 shadow-sm">
            Загружаем расходы…
          </div>
        )}

        {loadError && (
          <div ref={loadErrorRef} role="alert" tabIndex={-1} className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 outline-none">
            <p className="font-medium">{loadError}</p>
            <button type="button" onClick={() => void load(month)} className="mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-semibold outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500">Повторить</button>
          </div>
        )}

        {model && (
          <>
            <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-2 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center justify-between gap-2 sm:justify-start">
                <button
                  type="button"
                  aria-label="Предыдущий месяц"
                  disabled={navigationLocked}
                  onClick={() => setMonth(model.period.previous)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-600 outline-none transition-colors hover:bg-gray-100 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ChevronLeft aria-hidden="true" className="h-5 w-5" />
                </button>
                <div className="min-w-40 text-center">
                  <p className="font-semibold text-gray-950">{model.period.label}</p>
                  <p className="mt-0.5 text-xs text-gray-500">Данные на {model.period.asOf}</p>
                </div>
                <button
                  type="button"
                  aria-label="Следующий месяц"
                  disabled={navigationLocked}
                  onClick={() => setMonth(model.period.next)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-600 outline-none transition-colors hover:bg-gray-100 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ChevronRight aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>

              <div role="tablist" aria-label="Разделы оплат" className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 sm:inline-grid">
                <button
                  id="payments-requests-tab"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'requests'}
                  aria-controls="payments-requests-panel"
                  disabled={navigationLocked && activeTab !== 'requests'}
                  onClick={() => setActiveTab('requests')}
                  className={`min-h-10 rounded-md px-4 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                    activeTab === 'requests' ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-600 hover:text-gray-950'
                  }`}
                >
                  Расходы
                </button>
                <button
                  id="payments-stats-tab"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'stats'}
                  aria-controls="payments-stats-panel"
                  disabled={navigationLocked && activeTab !== 'stats'}
                  onClick={() => setActiveTab('stats')}
                  className={`min-h-10 rounded-md px-4 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                    activeTab === 'stats' ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-600 hover:text-gray-950'
                  }`}
                >
                  Статистика
                </button>
              </div>
            </div>

            <PaymentLimitSummary summary={model.summary} canManage={model.canManage} />

            <div
              role="tabpanel"
              id="payments-requests-panel"
              aria-labelledby="payments-requests-tab"
              hidden={activeTab !== 'requests'}
              className="space-y-5"
            >
              <div id="new-payment-form-panel" hidden={!isFormOpen}>
                <PaymentRequestForm
                  projects={model.projects}
                  summary={model.summary}
                  periodKey={model.period.key}
                  onSubmittingChange={setSubmittingExpense}
                  onSubmit={submit}
                />
              </div>
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
    </section>
  );
}
