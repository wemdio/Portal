'use client';

import { useState } from 'react';

import { expensesFetch } from '@/lib/expenses/client';
import { EXPENSE_CATEGORY_VALUES, categoryLabel } from '@/lib/expenses/labels';
import type { ExpenseCategory } from '@/lib/expenses/types';

export interface VendorOption {
  id: string;
  name: string;
}

interface CreatedVendor {
  id: string;
  name: string;
  category: ExpenseCategory;
}

/** Вендор с таким именем уже есть: роут отдаёт 409 с текстом Postgres, читать который человеку нечем. */
function humanizeError(message: string): string {
  if (/duplicate key|unique constraint/i.test(message)) return 'Вендор с таким названием уже есть';
  return message;
}

/**
 * Выбор вендора с созданием нового прямо здесь.
 *
 * Без создания на месте очередь разметки нерабочая на старте: список вендоров
 * приходит из разбивки за период, а она пуста, пока ничего не размечено —
 * замкнутый круг.
 *
 * Внутри намеренно нет `<form>`: компонент живёт внутри формы ручной траты, а
 * вложенные формы — невалидный HTML, из-за которого внешняя форма
 * отправляется не тем сабмитом.
 */
export default function VendorSelect({
  value,
  onChange,
  options,
  onCreated,
  emptyLabel = 'Выбрать вендора…',
  ariaLabel = 'Вендор',
}: {
  value: string;
  onChange: (vendorId: string) => void;
  options: VendorOption[];
  onCreated: (vendor: VendorOption) => void;
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('tools');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Название вендора короче двух символов');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await expensesFetch<CreatedVendor>('/vendors', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed, category }),
      });
      onCreated({ id: created.id, name: created.name });
      onChange(created.id);
      setName('');
      setCreating(false);
    } catch (e) {
      setError(humanizeError(e instanceof Error ? e.message : 'Не удалось создать вендора'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel}
          className="max-w-[220px] rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        >
          <option value="">{emptyLabel}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setCreating((prev) => !prev);
            setError(null);
          }}
          aria-expanded={creating}
          className="rounded-full border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          {creating ? 'Отмена' : '+ новый'}
        </button>
      </div>

      {creating ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="Название вендора"
            aria-label="Название нового вендора"
            className="w-44 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
            aria-label="Категория нового вендора"
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          >
            {EXPENSE_CATEGORY_VALUES.map((item) => (
              <option key={item} value={item}>
                {categoryLabel(item)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void create()}
            disabled={saving}
            className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs text-white disabled:opacity-40"
          >
            {saving ? 'Создаю…' : 'Создать'}
          </button>
        </div>
      ) : null}

      {error ? <div className="text-[11px] text-red-600">{error}</div> : null}
    </div>
  );
}
