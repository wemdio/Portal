'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SidePanel } from '@/components/ui/SidePanel';
import { FIELDS, type Field, type TableKey } from './libraryFields';
import type { Rec } from './libraryFilters';

const inputCls =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';

function toForm(fields: Field[], rec: Rec | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = rec?.[f.key];
    if (f.type === 'multi') out[f.key] = Array.isArray(v) ? v : [];
    else if (f.type === 'bool') out[f.key] = Boolean(v);
    else if (f.type === 'date') out[f.key] = typeof v === 'string' ? v.slice(0, 10) : '';
    else if (f.type === 'select') out[f.key] = v ?? f.options?.[0]?.[0] ?? '';
    else out[f.key] = v ?? '';
  }
  return out;
}

/** Поля в порядке объявления, сгруппированные по `group`. */
function groupFields(fields: Field[]): Array<[string, Field[]]> {
  const groups: Array<[string, Field[]]> = [];
  for (const f of fields) {
    const last = groups[groups.length - 1];
    if (last && last[0] === f.group) last[1].push(f);
    else groups.push([f.group, [f]]);
  }
  return groups;
}

function FieldInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === 'textarea') {
    return <textarea className={inputCls} rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === 'bool') {
    return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (field.type === 'select') {
    return (
      <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {field.options?.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'multi') {
    const list = (value as string[]) ?? [];
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {field.options?.map(([p, l]) => (
          <label key={p} className="flex items-center gap-1.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={list.includes(p)}
              onChange={() => onChange(list.includes(p) ? list.filter((x) => x !== p) : [...list, p])}
            />
            {l}
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      className={inputCls}
      type={field.type === 'date' ? 'date' : 'text'}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

interface Props {
  table: TableKey;
  /** `null` — создание новой записи. */
  record: Rec | null;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

/**
 * Редактирование записи библиотеки в выезжающей панели: поля разложены по
 * группам, список под панелью остаётся на месте.
 */
export function LibraryRecordForm({ table, record, onSave, onClose }: Props) {
  const fields = FIELDS[table];
  const [values, setValues] = useState<Record<string, unknown>>(() => toForm(fields, record));
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: unknown) => setValues((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(values);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SidePanel
      open
      title={record ? 'Изменить запись' : 'Новая запись'}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">
            Отмена
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="inline-flex items-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Сохранить
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        {groupFields(fields).map(([group, groupItems]) => (
          <section key={group}>
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">{group}</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {groupItems.map((f) => (
                <div key={f.key} className={f.type === 'textarea' || f.type === 'multi' ? 'sm:col-span-2' : ''}>
                  <label className="mb-1 block text-xs font-medium text-gray-700">{f.label}</label>
                  <FieldInput field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
                  {f.hint ? <div className="mt-1 text-xs text-gray-500">{f.hint}</div> : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SidePanel>
  );
}
