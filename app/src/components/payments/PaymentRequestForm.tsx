'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type {
  PaymentMonthSummary,
  PaymentCostCategory,
  PaymentDepartment,
  PaymentProject,
  SubmitPaymentRequestInput,
  SubmitPaymentRequestResponse,
} from '@/lib/payments/types';
import { formatTeamProjectLabel } from '@/lib/teamProjectLabel';
import { currentMoscowDate } from '@/lib/calendarDate';

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
  budgetMode: 'one_time' | 'planned' | 'costs';
  costCategory: PaymentCostCategory | '';
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
  budgetMode: 'one_time',
  costCategory: '',
  expectedPaymentOn: '',
  urgency: 'normal',
  documentUrl: '',
};

const inputClass = 'min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition-colors hover:border-gray-300 focus-visible:border-blue-500 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-blue-100';

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
  const isCosts = draft.budgetMode === 'costs';
  const today = currentMoscowDate();
  const costDateInFuture = isCosts && draft.expectedPaymentOn > today;
  const relevantRemaining = isCosts ? summary.costBudget.remaining : summary.remaining;
  const costBudgetIncomplete = isCosts
    && !targetsAnotherMonth
    && !summary.costBudget.dataComplete;
  const costLimitExceeded = isCosts
    && !targetsAnotherMonth
    && Number.isFinite(amount)
    && amount > relevantRemaining;
  const costBudgetBlocked = costBudgetIncomplete || costLimitExceeded;
  const needsApproval = draft.budgetMode === 'planned'
    || (!isCosts && !targetsAnotherMonth && Number.isFinite(amount) && amount > relevantRemaining);
  const valid = draft.description.trim().length > 0
    && amount > 0
    && draft.expectedPaymentOn.length > 0
    && (!isCosts || draft.costCategory !== '')
    && !costDateInFuture
    && !costBudgetBlocked;

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
        expenseType: draft.budgetMode === 'planned' ? 'planned' : 'one_time',
        budgetScope: isCosts ? 'costs' : 'general',
        costCategory: isCosts ? draft.costCategory as PaymentCostCategory : null,
        expectedPaymentOn: draft.expectedPaymentOn,
        urgency: isCosts ? 'normal' : draft.urgency,
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
      className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{isCosts ? 'Оплаченный расход' : 'Новая заявка'}</p>
        <h2 className="mt-1 text-lg font-semibold text-gray-950">Добавить расход</h2>
        <p className="mt-1 text-sm text-gray-500">{isCosts
          ? 'Вносите уже оплаченные покупки. Сумма сразу попадёт в факт, отдельное подтверждение Ани не нужно.'
          : 'Внутри лимита расход сразу учитывается оплаченным. Плановые и сверх лимита учитываются после согласования Ани.'}</p>
      </div>

      <div className="grid gap-x-5 gap-y-4 px-5 py-5 sm:grid-cols-2 sm:px-6 sm:py-6">
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-gray-800">Контур бюджета</legend>
          <div role="radiogroup" aria-label="Контур бюджета" className="mt-2 grid gap-3 lg:grid-cols-3">
            <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
              draft.budgetMode === 'one_time'
                ? 'border-gray-900 bg-gray-50 ring-1 ring-gray-900'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}>
              <input
                type="radio"
                name="budgetMode"
                value="one_time"
                checked={draft.budgetMode === 'one_time'}
                onChange={() => setDraft((current) => ({ ...current, budgetMode: 'one_time' }))}
                className="mt-0.5 h-4 w-4"
              />
              <span><span className="block text-sm font-semibold text-gray-900">Разовый</span><span className="mt-0.5 block text-xs leading-5 text-gray-500">Учитывается в месячном лимите</span></span>
            </label>
            <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
              draft.budgetMode === 'planned'
                ? 'border-gray-900 bg-gray-50 ring-1 ring-gray-900'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}>
              <input
                type="radio"
                name="budgetMode"
                value="planned"
                checked={draft.budgetMode === 'planned'}
                onChange={() => setDraft((current) => ({ ...current, budgetMode: 'planned' }))}
                className="mt-0.5 h-4 w-4"
              />
              <span><span className="block text-sm font-semibold text-gray-900">Плановый</span><span className="mt-0.5 block text-xs leading-5 text-gray-500">Не входит в лимит, тип подтверждает Аня</span></span>
            </label>
            <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
              draft.budgetMode === 'costs'
                ? 'border-gray-900 bg-gray-50 ring-1 ring-gray-900'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}>
              <input
                type="radio"
                name="budgetMode"
                value="costs"
                checked={draft.budgetMode === 'costs'}
                onChange={() => setDraft((current) => ({ ...current, budgetMode: 'costs' }))}
                className="mt-0.5 h-4 w-4"
              />
              <span><span className="block text-sm font-semibold text-gray-900">Косты</span><span className="mt-0.5 block text-xs leading-5 text-gray-500">Instantly, почты, базы и домены, лимит 650 000 ₽</span></span>
            </label>
          </div>
        </fieldset>

        {isCosts && (
          <label className="text-sm font-medium text-gray-800 sm:col-span-2">
            Категория костов
            <select
              required
              value={draft.costCategory}
              onChange={(event) => setDraft((current) => ({
                ...current,
                costCategory: event.target.value as PaymentCostCategory,
              }))}
              className={`${inputClass} mt-1.5`}
            >
              <option value="" disabled>Выберите категорию</option>
              <option value="instantly">Instantly</option>
              <option value="email">Почты</option>
              <option value="bases">Базы</option>
              <option value="domains">Домены</option>
              <option value="other">Другое</option>
            </select>
            {draft.costCategory === 'email' && (
              <span className="mt-1.5 block text-xs leading-5 text-gray-500">
                Записи со статусом «Оставить» уже приходят из календаря автоматически. Не дублируйте их вручную.
              </span>
            )}
            {draft.costCategory === 'other' && (
              <span className="mt-1.5 block text-xs leading-5 text-gray-500">
                Подписки «Оставить» из календаря технички уже учитываются автоматически. Не дублируйте их вручную.
              </span>
            )}
          </label>
        )}

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

        {!isCosts && (
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
        )}

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
          {isCosts ? 'Фактическая дата оплаты' : 'Дата оплаты'}
          <input
            type="date"
            required
            max={isCosts ? today : undefined}
            value={draft.expectedPaymentOn}
            onChange={(event) => setDraft((current) => ({ ...current, expectedPaymentOn: event.target.value }))}
            className={`${inputClass} mt-1.5`}
          />
          {costDateInFuture && (
            <span role="alert" className="mt-1.5 block text-xs text-red-700">
              Оплата уже должна быть совершена. Укажите сегодняшнюю или прошедшую дату.
            </span>
          )}
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
          <div className={`rounded-xl border px-4 py-3 text-sm leading-5 sm:col-span-2 ${
            needsApproval || costBudgetBlocked
              ? 'border-amber-200 bg-amber-50 text-amber-950'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}>
            {draft.budgetMode === 'planned' ? (
              <p>Плановый расход не уменьшает лимит разовых и будет отправлен Ане.</p>
            ) : costBudgetIncomplete ? (
              <p>Для календарных расходов не хватает курса валюты. Пока сумма не пересчитана в рубли, новый кост добавить нельзя.</p>
            ) : targetsAnotherMonth ? (
              <p>{isCosts
                ? 'Лимит проверяется по фактической дате оплаты. После сохранения откроется месяц этой оплаты.'
                : 'Лимит выбранного месяца проверит сервер. После отправки откроется месяц ожидаемой оплаты.'}</p>
            ) : costLimitExceeded ? (
              <p>{`Превышает доступный остаток костов на ${formatRubles(amount - relevantRemaining)}. Проверьте сумму, дату и доступный бюджет. Не меняйте дату фактической оплаты ради лимита.`}</p>
            ) : !isCosts && amount > relevantRemaining ? (
              <p>{`Превышает доступный остаток на ${formatRubles(amount - relevantRemaining)}. Расход будет отправлен Ане.`}</p>
            ) : (
              <p>{isCosts
                ? 'Кост сразу запишется как оплаченный. Перед сохранением сервер проверит остаток лимита.'
                : draft.expectedPaymentOn > today
                  ? 'Сумма зарезервируется и автоматически попадёт в оплаченные в указанную дату.'
                  : 'Расход сразу запишется как оплаченный. Перед сохранением проверим остаток лимита.'}</p>
            )}
            {!isCosts && (needsApproval || targetsAnotherMonth) && (
              <p className="mt-2">После одобрения расход считается оплаченным по указанной дате. Будущая выплата остаётся в резерве до этой даты.</p>
            )}
          </div>
        )}

        {error && (
          <div ref={errorRef} role="alert" tabIndex={-1} className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 outline-none sm:col-span-2">
            {error}
          </div>
        )}
        <div className="flex justify-end border-t border-gray-100 pt-5 sm:col-span-2">
          <button
            type="submit"
            disabled={!valid || submitting}
            className="min-h-11 w-full rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white outline-none transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-300 sm:w-auto"
          >
            {submitting
              ? 'Сохраняем…'
              : costBudgetIncomplete
                ? 'Недоступно до пересчёта курса'
                : costLimitExceeded
                ? 'Недоступно сверх лимита'
                : needsApproval
                  ? 'Отправить Ане'
                  : isCosts ? 'Записать оплату' : 'Добавить расход'}
          </button>
        </div>
      </div>
    </form>
  );
}
