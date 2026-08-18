'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type {
  PaymentMonthSummary,
  PaymentDepartment,
  PaymentProject,
  SubmitPaymentRequestInput,
  SubmitPaymentRequestResponse,
} from '@/lib/payments/types';
import { formatTeamProjectLabel } from '@/lib/teamProjectLabel';

import { formatRubles, PAYMENT_DEPARTMENTS } from './format';

interface PaymentRequestFormProps {
  projects: PaymentProject[];
  summary: PaymentMonthSummary;
  periodKey: string;
  onSubmittingChange?: (submitting: boolean) => void;
  onSubmit: (input: SubmitPaymentRequestInput) => Promise<SubmitPaymentRequestResponse>;
}

interface PaymentDraft {
  department: PaymentDepartment;
  description: string;
  amount: string;
  projectId: string;
  comment: string;
  expenseType: 'one_time' | 'planned';
  expectedPaymentOn: string;
  urgency: 'normal' | 'urgent' | 'critical';
  documentUrl: string;
}

const EMPTY_DRAFT: PaymentDraft = {
  department: 'outreach',
  description: '',
  amount: '',
  projectId: '',
  comment: '',
  expenseType: 'one_time',
  expectedPaymentOn: '',
  urgency: 'normal',
  documentUrl: '',
};

const inputClass = 'min-h-11 w-full border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось отправить расход';
}

export default function PaymentRequestForm({
  projects,
  summary,
  periodKey,
  onSubmittingChange,
  onSubmit,
}: PaymentRequestFormProps) {
  const [draft, setDraft] = useState<PaymentDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  const amount = useMemo(() => Number(draft.amount), [draft.amount]);
  const targetMonth = draft.expectedPaymentOn.slice(0, 7);
  const targetsAnotherMonth = targetMonth.length === 7 && targetMonth !== periodKey;
  const needsApproval = draft.expenseType === 'planned'
    || (!targetsAnotherMonth && Number.isFinite(amount) && amount > summary.remaining);
  const valid = draft.description.trim().length > 0
    && amount > 0
    && draft.expectedPaymentOn.length > 0;

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || submitting) return;

    setSubmitting(true);
    onSubmittingChange?.(true);
    setError('');
    try {
      await onSubmit({
        department: draft.department,
        description: draft.description.trim(),
        amount,
        projectId: draft.projectId || null,
        comment: draft.comment.trim() || null,
        expenseType: draft.expenseType,
        expectedPaymentOn: draft.expectedPaymentOn,
        urgency: draft.urgency,
        documentUrl: draft.documentUrl.trim() || null,
      });
      setDraft(EMPTY_DRAFT);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  return (
    <form
      aria-label="Новый расход"
      onSubmit={(event) => void handleSubmit(event)}
      className="border border-gray-200 bg-white"
    >
      <div className="border-b border-gray-200 px-4 py-3 sm:px-5">
        <h2 className="font-semibold text-gray-900">Новый расход</h2>
        <p className="mt-1 text-xs text-gray-500">Решение и резерв рассчитает сервер после отправки.</p>
      </div>

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5">
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-gray-800">Тип расхода</legend>
          <div role="radiogroup" aria-label="Тип расхода" className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 cursor-pointer items-start gap-3 border border-gray-300 px-3 py-2.5">
              <input
                type="radio"
                name="expenseType"
                value="one_time"
                checked={draft.expenseType === 'one_time'}
                onChange={() => setDraft((current) => ({ ...current, expenseType: 'one_time' }))}
                className="mt-0.5 h-4 w-4"
              />
              <span><span className="block text-sm font-medium">Разовый</span><span className="block text-xs text-gray-500">Учитывается в месячном лимите</span></span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 border border-gray-300 px-3 py-2.5">
              <input
                type="radio"
                name="expenseType"
                value="planned"
                checked={draft.expenseType === 'planned'}
                onChange={() => setDraft((current) => ({ ...current, expenseType: 'planned' }))}
                className="mt-0.5 h-4 w-4"
              />
              <span><span className="block text-sm font-medium">Плановый</span><span className="block text-xs text-gray-500">Всегда требует согласования</span></span>
            </label>
          </div>
        </fieldset>

        <label className="text-sm font-medium text-gray-800">
          Отдел
          <select
            value={draft.department}
            onChange={(event) => setDraft((current) => ({
              ...current,
              department: event.target.value as PaymentDepartment,
            }))}
            className={`${inputClass} mt-1.5`}
          >
            {PAYMENT_DEPARTMENTS.map((department) => (
              <option key={department.value} value={department.value}>{department.label}</option>
            ))}
          </select>
        </label>

        <label className="text-sm font-medium text-gray-800">
          Срочность
          <select
            value={draft.urgency}
            onChange={(event) => setDraft((current) => ({
              ...current,
              urgency: event.target.value as PaymentDraft['urgency'],
            }))}
            className={`${inputClass} mt-1.5`}
          >
            <option value="normal">Обычная</option>
            <option value="urgent">Высокая</option>
            <option value="critical">Критическая</option>
          </select>
        </label>

        <label className="text-sm font-medium text-gray-800 sm:col-span-2">
          На что расход
          <input
            type="text"
            required
            value={draft.description}
            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            className={`${inputClass} mt-1.5`}
          />
        </label>

        <label className="text-sm font-medium text-gray-800">
          Сумма, ₽
          <input
            type="number"
            min="0.01"
            step="0.01"
            required
            value={draft.amount}
            onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))}
            className={`${inputClass} mt-1.5 tabular-nums`}
          />
        </label>

        <label className="text-sm font-medium text-gray-800">
          Предполагаемая дата оплаты
          <input
            type="date"
            required
            value={draft.expectedPaymentOn}
            onChange={(event) => setDraft((current) => ({ ...current, expectedPaymentOn: event.target.value }))}
            className={`${inputClass} mt-1.5`}
          />
        </label>

        <label className="text-sm font-medium text-gray-800">
          Проект, необязательно
          <select
            value={draft.projectId}
            onChange={(event) => setDraft((current) => ({ ...current, projectId: event.target.value }))}
            className={`${inputClass} mt-1.5`}
          >
            <option value="">Без проекта</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {formatTeamProjectLabel(project.client, project.name)}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm font-medium text-gray-800">
          Ссылка на счёт или документ, необязательно
          <input
            type="url"
            value={draft.documentUrl}
            onChange={(event) => setDraft((current) => ({ ...current, documentUrl: event.target.value }))}
            placeholder="https://"
            className={`${inputClass} mt-1.5`}
          />
        </label>

        <label className="text-sm font-medium text-gray-800 sm:col-span-2">
          Комментарий, необязательно
          <textarea
            rows={3}
            value={draft.comment}
            onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))}
            className={`${inputClass} mt-1.5 resize-y`}
          />
        </label>

        {amount > 0 && (
          <div className="border-l-2 border-gray-300 pl-3 text-sm text-gray-700 sm:col-span-2">
            {draft.expenseType === 'planned' ? (
              <p>Плановый расход не уменьшает лимит разовых и будет отправлен Ане.</p>
            ) : targetsAnotherMonth ? (
              <p>Лимит выбранного месяца проверит сервер. После отправки откроется месяц ожидаемой оплаты.</p>
            ) : amount > summary.remaining ? (
              <p>Превышает доступный остаток на {formatRubles(amount - summary.remaining)}. Расход будет отправлен Ане.</p>
            ) : (
              <p>Расход будет одобрен автоматически. После отправки сервер ещё раз проверит остаток.</p>
            )}
          </div>
        )}

        {error && (
          <div ref={errorRef} role="alert" tabIndex={-1} className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 outline-none sm:col-span-2">
            {error}
          </div>
        )}
        <div className="flex justify-end sm:col-span-2">
          <button
            type="submit"
            disabled={!valid || submitting}
            className="min-h-11 w-full bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-300 sm:w-auto"
          >
            {submitting ? 'Отправляем…' : needsApproval ? 'Отправить Ане' : 'Добавить расход'}
          </button>
        </div>
      </div>
    </form>
  );
}
