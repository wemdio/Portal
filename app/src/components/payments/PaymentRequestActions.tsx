'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

import type {
  NewPaymentExpenseType,
  PaymentRequest,
  PaymentRequestActionInput,
  PaymentRequestActionResponse,
} from '@/lib/payments/types';

import { formatPaymentDate } from './format';

interface PaymentRequestActionsProps {
  request: PaymentRequest;
  asOf: string;
  disabled?: boolean;
  onDraftOpenChange?: (open: boolean) => void;
  onRefreshRequest: (id: string) => Promise<PaymentRequest | null>;
  onAction: (
    id: string,
    input: PaymentRequestActionInput,
  ) => Promise<PaymentRequestActionResponse>;
}

type ActionMode = 'idle' | 'reject' | 'paid' | 'legacy';

const buttonClass = 'min-h-11 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-xs font-semibold text-gray-800 outline-none transition-colors hover:border-gray-300 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-100';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось изменить расход';
}

export default function PaymentRequestActions({
  request,
  asOf,
  disabled = false,
  onDraftOpenChange,
  onRefreshRequest,
  onAction,
}: PaymentRequestActionsProps) {
  const [mode, setMode] = useState<ActionMode>('idle');
  const [decisionComment, setDecisionComment] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [expenseType, setExpenseType] = useState<NewPaymentExpenseType>('one_time');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restoreFocusTo, setRestoreFocusTo] = useState<Exclude<ActionMode, 'idle'> | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const decisionRef = useRef<HTMLTextAreaElement>(null);
  const paidOnRef = useRef<HTMLInputElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const paidButtonRef = useRef<HTMLButtonElement>(null);
  const legacyButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      return;
    }
    if (mode === 'reject') decisionRef.current?.focus();
    if (mode === 'paid' || mode === 'legacy') paidOnRef.current?.focus();
  }, [error, mode]);

  useEffect(() => {
    if (mode !== 'idle' || !restoreFocusTo) return;
    const target = restoreFocusTo === 'reject'
      ? rejectButtonRef.current
      : restoreFocusTo === 'paid'
        ? paidButtonRef.current
        : legacyButtonRef.current;
    target?.focus();
  }, [mode, restoreFocusTo]);

  function open(nextMode: ActionMode) {
    setError('');
    setNotice('');
    setRestoreFocusTo(null);
    setMode(nextMode);
    onDraftOpenChange?.(nextMode !== 'idle');
  }

  function cancel() {
    if (mode !== 'idle') setRestoreFocusTo(mode);
    setError('');
    setMode('idle');
    onDraftOpenChange?.(false);
  }

  async function run(input: PaymentRequestActionInput) {
    const locksParentWhileSaving = mode === 'idle';
    setBusy(true);
    if (locksParentWhileSaving) onDraftOpenChange?.(true);
    setError('');
    try {
      const result = await onAction(request.id, input);
      setMode('idle');
      onDraftOpenChange?.(false);
      return result;
    } catch (actionError) {
      setError(errorMessage(actionError));
      if (locksParentWhileSaving) onDraftOpenChange?.(false);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refreshAfterConflict() {
    setRefreshing(true);
    const refreshed = await onRefreshRequest(request.id);
    setRefreshing(false);
    if (!refreshed) return;

    const actionStillAvailable = mode === 'reject'
      ? refreshed.status === 'pending' || refreshed.status === 'approved'
      : mode === 'paid'
        ? refreshed.status === 'approved'
        : mode === 'legacy'
          ? refreshed.expenseType === 'legacy_unclassified'
          : true;
    setError('');
    if (actionStillAvailable) return;

    setMode('idle');
    onDraftOpenChange?.(false);
    setNotice('Данные обновлены: выбранное действие больше недоступно.');
  }

  async function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decisionComment.trim()) return;
    await run({
      action: 'reject',
      decisionComment: decisionComment.trim(),
      expectedUpdatedAt: request.updatedAt,
    });
  }

  async function markPaid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paidOn) return;
    await run({ action: 'mark_paid', paidOn, expectedUpdatedAt: request.updatedAt });
  }

  async function classifyLegacy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paidOn) return;
    await run({
      action: 'classify_legacy',
      expenseType,
      paidOn,
      expectedUpdatedAt: request.updatedAt,
    });
  }

  const errorAlert = error ? (
    <div
      ref={errorRef}
      role="alert"
      tabIndex={-1}
      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800 outline-none"
    >
      <p>{error}</p>
      {error.startsWith('Заявка уже изменилась') && (
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refreshAfterConflict()}
          className={`${buttonClass} mt-2`}
        >
          {refreshing ? 'Обновляем…' : 'Обновить данные'}
        </button>
      )}
    </div>
  ) : null;

  if (mode === 'reject') {
    return (
      <form aria-label="Отклонить расход" onSubmit={(event) => void reject(event)} className="ml-auto max-w-md space-y-3 rounded-xl bg-gray-50 p-4">
        <label className="block text-xs font-medium text-gray-700">
          Причина отклонения
          <textarea
            ref={decisionRef}
            required
            rows={3}
            value={decisionComment}
            onChange={(event) => setDecisionComment(event.target.value)}
            className={`${inputClass} mt-1 resize-y`}
          />
        </label>
        {errorAlert}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !decisionComment.trim()} className={buttonClass}>
            {busy ? 'Сохраняем…' : 'Подтвердить отклонение'}
          </button>
          <button type="button" onClick={cancel} disabled={busy} className={buttonClass}>Отмена</button>
        </div>
      </form>
    );
  }

  if (mode === 'paid') {
    return (
      <form aria-label="Отметить расход оплаченным" onSubmit={(event) => void markPaid(event)} className="ml-auto max-w-md space-y-3 rounded-xl bg-gray-50 p-4">
        <label className="block text-xs font-medium text-gray-700">
          Фактическая дата оплаты
          <input
            ref={paidOnRef}
            type="date"
            required
            max={asOf}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </label>
        {errorAlert}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !paidOn} className={buttonClass}>
            {busy ? 'Сохраняем…' : 'Подтвердить оплату'}
          </button>
          <button type="button" onClick={cancel} disabled={busy} className={buttonClass}>Отмена</button>
        </div>
      </form>
    );
  }

  if (mode === 'legacy') {
    return (
      <form aria-label="Уточнение старого расхода" onSubmit={(event) => void classifyLegacy(event)} className="ml-auto max-w-md space-y-3 rounded-xl bg-gray-50 p-4">
        <fieldset>
          <legend className="text-xs font-medium text-gray-700">Тип расхода</legend>
          <div role="radiogroup" aria-label="Тип расхода" className="mt-1 flex flex-wrap gap-3 text-xs">
            <label className="flex min-h-11 items-center gap-2"><input type="radio" name={`legacy-type-${request.id}`} checked={expenseType === 'one_time'} onChange={() => setExpenseType('one_time')} /> Разовый</label>
            <label className="flex min-h-11 items-center gap-2"><input type="radio" name={`legacy-type-${request.id}`} checked={expenseType === 'planned'} onChange={() => setExpenseType('planned')} /> Плановый</label>
          </div>
        </fieldset>
        <label className="block text-xs font-medium text-gray-700">
          Фактическая дата оплаты
          <input
            ref={paidOnRef}
            type="date"
            required
            max={asOf}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </label>
        <p className="text-xs leading-5 text-gray-500">
          Сейчас {formatPaymentDate(request.paidOn || request.expectedPaymentOn)} учтено по дате создания. Укажите реальную дату.
        </p>
        {errorAlert}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !paidOn} className={buttonClass}>
            {busy ? 'Сохраняем…' : 'Сохранить уточнение'}
          </button>
          <button type="button" onClick={cancel} disabled={busy} className={buttonClass}>Отмена</button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap justify-start gap-2 sm:justify-end">
      {notice && <p role="status" className="w-full text-xs text-gray-600">{notice}</p>}
      {request.status === 'pending' && (
        <>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void run({ action: 'approve', expectedUpdatedAt: request.updatedAt })}
            className={`${buttonClass} border-emerald-600 bg-emerald-600 text-white hover:border-emerald-700 hover:bg-emerald-700`}
          >
            {request.budgetScope === 'general' && request.expectedPaymentOn <= asOf ? 'Одобрить и учесть оплату' : 'Одобрить'}
          </button>
        </>
      )}
      {(request.status === 'pending' || request.status === 'approved') && (
        <button
          ref={rejectButtonRef}
          type="button"
          disabled={busy || disabled}
          onClick={() => open('reject')}
          className={`${buttonClass} border-red-300 text-red-800 hover:border-red-400 hover:bg-red-50`}
        >
          Отклонить
        </button>
      )}
      {request.status === 'approved' && !request.autoPaymentOn && (
        <button ref={paidButtonRef} type="button" disabled={busy || disabled} onClick={() => open('paid')} className={`${buttonClass} border-gray-900 bg-gray-900 text-white hover:bg-gray-800`}>
          Отметить оплаченным
        </button>
      )}
      {request.expenseType === 'legacy_unclassified' && (
        <button ref={legacyButtonRef} type="button" disabled={busy || disabled} onClick={() => open('legacy')} className={`${buttonClass} border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-400 hover:bg-amber-100`}>
          Уточнить тип и дату оплаты
        </button>
      )}
      {errorAlert}
    </div>
  );
}
