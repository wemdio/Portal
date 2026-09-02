'use client';

import { useId, useState } from 'react';

import { addCycle } from '@/lib/techCalendar/dates';
import {
  BILLING_CYCLES,
  CURRENCIES,
  CYCLE_LABELS,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  TECH_SOURCE_LABELS,
  type TechSubscription,
} from '@/lib/techCalendar/types';

export type ModalMode = 'create' | 'edit' | 'renew';

export interface ModalPayload {
  service_name: string;
  service_type: string;
  amount: number;
  currency: string;
  billing_cycle: string;
  next_billing_date: string;
  notes: string | null;
}

interface Props {
  mode: ModalMode;
  subscription: TechSubscription | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: ModalPayload) => void;
  /** Удаление живёт в самой карточке: отдельная кнопка на странице попадалась бы под руку случайно. */
  onDelete?: () => void;
  onToggleHidden?: () => void;
}

const EMPTY: ModalPayload = {
  service_name: '',
  service_type: 'other',
  amount: 0,
  currency: 'RUB',
  billing_cycle: 'monthly',
  next_billing_date: '',
  notes: null,
};

/**
 * Одно окно на три сценария. В режиме продления дата предзаполнена сдвигом на
 * цикл, но её и сумму можно поправить: цены на прокси и серверы меняются от
 * продления к продлению, и правят их обычно ровно в этот момент.
 */
export default function SubscriptionModal({ mode, subscription, saving, error, onClose, onSubmit, onDelete, onToggleHidden }: Props) {
  const titleId = useId();
  const [form, setForm] = useState<ModalPayload>(() => {
    if (!subscription) return EMPTY;
    const base: ModalPayload = {
      service_name: subscription.service_name,
      service_type: subscription.service_type,
      amount: subscription.amount,
      currency: subscription.currency,
      billing_cycle: subscription.billing_cycle,
      next_billing_date: subscription.next_billing_date,
      notes: subscription.notes,
    };
    if (mode === 'renew') {
      base.next_billing_date = addCycle(subscription.next_billing_date, subscription.billing_cycle);
    }
    return base;
  });

  const title = mode === 'create' ? 'Новый сервис' : mode === 'renew' ? 'Продление' : 'Редактирование';
  const readOnlyFields = mode === 'renew';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id={titleId} className="text-base font-semibold text-gray-900">{title}</h3>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3">
          {subscription && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{TECH_SOURCE_LABELS[subscription.source]}</span>
              {subscription.provider_status && <span>Статус: {subscription.provider_status}</span>}
              {subscription.synced_at && <span>Синк: {new Date(subscription.synced_at).toLocaleString('ru-RU')}</span>}
              {subscription.is_hidden && <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-700">Скрыто</span>}
            </div>
          )}

          <label className="block">
            <span className="text-xs text-gray-500">Название сервиса</span>
            <input
              value={form.service_name}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, service_name: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            />
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">Тип</span>
            <select
              value={form.service_type}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, service_type: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              {SERVICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SERVICE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-500">Сумма</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Валюта</span>
              <select
                value={form.currency}
                disabled={readOnlyFields}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c === 'RUB' ? '₽ рубли' : '$ доллары'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-gray-500">Цикл оплаты</span>
            <select
              value={form.billing_cycle}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, billing_cycle: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              {BILLING_CYCLES.map((c) => (
                <option key={c} value={c}>
                  {CYCLE_LABELS[c]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">
              {mode === 'renew' ? 'Следующее списание после продления' : 'Дата следующего списания'}
            </span>
            <input
              type="date"
              value={form.next_billing_date}
              onChange={(e) => setForm({ ...form, next_billing_date: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">Заметка</span>
            <textarea
              value={form.notes ?? ''}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            />
          </label>
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <div className="mr-auto flex items-center gap-3">
            {mode === 'edit' && subscription && onToggleHidden && (
              <button type="button" onClick={onToggleHidden} className="text-xs text-gray-600 hover:underline">
                {subscription.is_hidden ? 'Вернуть в календарь' : 'Скрыть из календаря'}
              </button>
            )}
            {mode === 'edit' && onDelete && (
              <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline">
                Удалить сервис
              </button>
            )}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700">
            Отмена
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onSubmit(form)}
            className={`rounded-lg px-4 py-2 text-sm text-white disabled:opacity-60 ${mode === 'renew' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {saving ? 'Сохранение…' : mode === 'renew' ? 'Продлить' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
