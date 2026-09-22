'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { PROFILE_CODES, PROFILE_LABELS } from '@/lib/polzaRuOutreach/types';
import { API, api, fmtDate } from './shared';

type Rec = Record<string, unknown> & { id: string };
type FieldType = 'text' | 'textarea' | 'tags' | 'date' | 'bool' | 'select' | 'profiles';
interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: Array<[string, string]>;
  hint?: string;
}
type TableKey = 'cases' | 'claims' | 'senders';

const STATUS_OPTIONS: Array<[string, string]> = [
  ['draft', 'черновик'],
  ['approved', 'утверждено'],
  ['expired', 'истекло'],
];

const FIELDS: Record<TableKey, Field[]> = {
  cases: [
    { key: 'case_id', label: 'ID кейса', type: 'text', hint: 'короткий латиницей, например it_integrator_2026' },
    { key: 'public_name', label: 'Название для писем', type: 'text' },
    { key: 'case_text_short', label: 'Текст для письма (1–2 предложения)', type: 'textarea', hint: 'вставляется в письмо 2 дословно после «Для примера:»' },
    { key: 'industry_tags', label: 'Отрасли (через запятую)', type: 'tags', hint: 'по ним кейс подбирается к компании' },
    { key: 'product_tags', label: 'Продукты (через запятую)', type: 'tags' },
    { key: 'sales_model_tags', label: 'Модель продаж (через запятую)', type: 'tags' },
    { key: 'allowed_profiles', label: 'В каких офферах можно', type: 'profiles' },
    { key: 'status', label: 'Статус', type: 'select', options: STATUS_OPTIONS },
    { key: 'legal_publication_approved', label: 'Разрешено публиковать', type: 'bool' },
    { key: 'verified_by', label: 'Кто проверил цифры', type: 'text' },
    { key: 'expires_at', label: 'Действует до', type: 'date' },
    { key: 'source_file_or_url', label: 'Источник цифр', type: 'text' },
    { key: 'notes', label: 'Заметки', type: 'textarea' },
  ],
  claims: [
    { key: 'profile_code', label: 'Оффер', type: 'select', options: [['all', 'все офферы'], ...PROFILE_CODES.map((p) => [p, PROFILE_LABELS[p]] as [string, string])] },
    {
      key: 'claim_key',
      label: 'Куда вставлять',
      type: 'select',
      options: [
        ['letter2_value', 'письмо 2 (SDR, сигналы)'],
        ['letter1_value', 'письмо 1 (автоматизация)'],
      ],
    },
    { key: 'claim_text', label: 'Текст утверждения', type: 'textarea', hint: 'все цифры, сроки и гарантии — только отсюда' },
    { key: 'status', label: 'Статус', type: 'select', options: STATUS_OPTIONS },
    { key: 'approved_by', label: 'Кто утвердил', type: 'text' },
    { key: 'expires_at', label: 'Действует до', type: 'date' },
  ],
  senders: [
    { key: 'sender_name', label: 'Имя', type: 'text' },
    { key: 'sender_title', label: 'Должность', type: 'text' },
    { key: 'company_name', label: 'Компания', type: 'text' },
    { key: 'phone', label: 'Телефон', type: 'text' },
    { key: 'website', label: 'Сайт', type: 'text' },
    { key: 'telegram', label: 'Telegram', type: 'text' },
    { key: 'status', label: 'Статус', type: 'select', options: [['active', 'активна'], ['inactive', 'выключена']] },
    { key: 'is_default', label: 'По умолчанию', type: 'bool' },
  ],
};

const TITLES: Record<TableKey, { title: string; hint: string; summary: (r: Rec) => string }> = {
  cases: {
    title: 'Кейсы',
    hint: 'В письмо попадает только утверждённый кейс с разрешением на публикацию и совпадающими тегами. Нет подходящего — письмо 2 идёт без кейса.',
    summary: (r) => `${r.public_name} — ${r.case_text_short}`,
  },
  claims: {
    title: 'Утверждения оффера',
    hint: 'Цифры, цены, сроки и гарантии. Без утверждённой записи письма остаются без цифр.',
    summary: (r) => String(r.claim_text),
  },
  senders: {
    title: 'Подписи',
    hint: 'Подпись берётся целиком из профиля и не смешивается с другой.',
    summary: (r) => [r.sender_name, r.sender_title, r.company_name, r.phone, r.website, r.telegram].filter(Boolean).join(' · '),
  },
};

const inputCls =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';

function toForm(fields: Field[], rec: Rec | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = rec?.[f.key];
    if (f.type === 'tags') out[f.key] = Array.isArray(v) ? v.join(', ') : '';
    else if (f.type === 'profiles') out[f.key] = Array.isArray(v) ? v : [];
    else if (f.type === 'bool') out[f.key] = Boolean(v);
    else if (f.type === 'date') out[f.key] = typeof v === 'string' ? v.slice(0, 10) : '';
    else if (f.type === 'select') out[f.key] = v ?? f.options?.[0]?.[0] ?? '';
    else out[f.key] = v ?? '';
  }
  return out;
}

function RecordForm({ table, initial, onSave, onCancel }: { table: TableKey; initial: Rec | null; onSave: (v: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const fields = FIELDS[table];
  const [values, setValues] = useState<Record<string, unknown>>(() => toForm(fields, initial));
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: unknown) => setValues((prev) => ({ ...prev, [k]: v }));
  return (
    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/40 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.type === 'textarea' ? 'md:col-span-2' : ''}>
            <label className="mb-1 block text-xs font-medium text-gray-700">{f.label}</label>
            {f.type === 'textarea' ? (
              <textarea className={inputCls} rows={3} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === 'bool' ? (
              <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
            ) : f.type === 'select' ? (
              <select className={inputCls} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                {f.options?.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            ) : f.type === 'profiles' ? (
              <div className="flex flex-wrap gap-3">
                {PROFILE_CODES.map((p) => {
                  const list = (values[f.key] as string[]) ?? [];
                  return (
                    <label key={p} className="flex items-center gap-1.5 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={list.includes(p)}
                        onChange={() => set(f.key, list.includes(p) ? list.filter((x) => x !== p) : [...list, p])}
                      />
                      {PROFILE_LABELS[p]}
                    </label>
                  );
                })}
              </div>
            ) : (
              <input className={inputCls} type={f.type === 'date' ? 'date' : 'text'} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
            )}
            {f.hint ? <div className="mt-0.5 text-xs text-gray-500">{f.hint}</div> : null}
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(values);
            } finally {
              setSaving(false);
            }
          }}
          className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Сохранить
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
          Отмена
        </button>
      </div>
    </div>
  );
}

function LibrarySection({ table, rows, onChanged, onError }: { table: TableKey; rows: Rec[]; onChanged: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const meta = TITLES[table];

  const save = async (values: Record<string, unknown>) => {
    try {
      if (editing === 'new') {
        await api(`${API}/libraries`, { method: 'POST', body: JSON.stringify({ table, record: values }) });
      } else if (editing) {
        await api(`${API}/libraries`, { method: 'PATCH', body: JSON.stringify({ table, id: editing.id, patch: values }) });
      }
      setEditing(null);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не удалось сохранить');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить запись?')) return;
    try {
      await api(`${API}/libraries?table=${table}&id=${id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-gray-900">{meta.title}</div>
          <p className="mt-0.5 max-w-3xl text-sm text-gray-500">{meta.hint}</p>
        </div>
        <button type="button" onClick={() => setEditing('new')} className="inline-flex shrink-0 items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          <Plus className="mr-1 h-4 w-4" /> Добавить
        </button>
      </div>
      {editing === 'new' && <RecordForm table={table} initial={null} onSave={save} onCancel={() => setEditing(null)} />}
      <div className="mt-3 divide-y divide-gray-100">
        {rows.length === 0 && <div className="py-3 text-sm text-gray-500">Пока пусто.</div>}
        {rows.map((r) => (
          <div key={r.id} className="py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm text-gray-800">
                <span
                  className={`mr-2 rounded-full px-2 py-0.5 text-xs ${
                    r.status === 'approved' || r.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {String(STATUS_OPTIONS.find(([v]) => v === r.status)?.[1] ?? (r.status === 'active' ? 'активна' : r.status === 'inactive' ? 'выключена' : r.status))}
                </span>
                {r.is_default ? <span className="mr-2 text-xs text-violet-700">по умолчанию</span> : null}
                {r.case_id ? <span className="mr-2 font-mono text-xs text-gray-500">{String(r.case_id)}</span> : null}
                {r.expires_at ? <span className="mr-2 text-xs text-gray-500">до {fmtDate(String(r.expires_at))}</span> : null}
                {meta.summary(r)}
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => setEditing(r)} className="rounded-md px-2 py-1 text-xs text-violet-700 hover:bg-violet-50">
                  Изменить
                </button>
                <button type="button" onClick={() => remove(r.id)} className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" aria-label="Удалить">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            {editing !== 'new' && editing?.id === r.id && <RecordForm table={table} initial={r} onSave={save} onCancel={() => setEditing(null)} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function UploadsSection({ uploads, onChanged, onError }: { uploads: Rec[]; onChanged: () => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<'exhibitors' | 'contracts'>('exhibitors');
  const [title, setTitle] = useState('');
  const [eventStart, setEventStart] = useState('');
  const [eventEnd, setEventEnd] = useState('');
  const [officialUrl, setOfficialUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setDone(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', kind);
      form.set('title', title);
      form.set('event_start', eventStart);
      form.set('event_end', eventEnd);
      form.set('official_url', officialUrl);
      if (eventStart) form.set('catalog_year', eventStart.slice(0, 4));
      const res = await authFetch(`${API}/uploads`, { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as { error?: string; rows?: number } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setDone(`Загружено строк: ${body?.rows ?? 0}`);
      setFile(null);
      setTitle('');
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не удалось загрузить');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить загрузку со всеми строками?')) return;
    try {
      await api(`${API}/uploads?id=${id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="text-base font-semibold text-gray-900">Файлы сигналов: выставки и госконтракты</div>
      <p className="mt-0.5 max-w-3xl text-sm text-gray-500">
        Каталог участников выставки (с официального сайта) или выгрузка результатов поиска контрактов из ЕИС — Excel или CSV.
        Нужна колонка с названием компании; сайт, ИНН, дата, предмет, сумма и заказчик распознаются по заголовкам.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as 'exhibitors' | 'contracts')}>
          <option value="exhibitors">Каталог выставки</option>
          <option value="contracts">Выгрузка контрактов ЕИС</option>
        </select>
        <input className={inputCls} placeholder={kind === 'exhibitors' ? 'Название выставки' : 'Название выгрузки'} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className={inputCls} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {kind === 'exhibitors' && (
          <>
            <input className={inputCls} type="date" value={eventStart} onChange={(e) => setEventStart(e.target.value)} title="Дата начала" />
            <input className={inputCls} type="date" value={eventEnd} onChange={(e) => setEventEnd(e.target.value)} title="Дата окончания" />
            <input className={inputCls} placeholder="Ссылка на официальный каталог" value={officialUrl} onChange={(e) => setOfficialUrl(e.target.value)} />
          </>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !file || !title || (kind === 'exhibitors' && !eventStart)}
          onClick={upload}
          className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
          Загрузить
        </button>
        {done && <span className="text-sm text-emerald-700">{done}</span>}
      </div>
      <div className="mt-4 divide-y divide-gray-100">
        {uploads.length === 0 && <div className="py-3 text-sm text-gray-500">Загрузок пока нет.</div>}
        {uploads.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0 text-gray-800">
              <span className="mr-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{u.kind === 'exhibitors' ? 'выставка' : 'контракты'}</span>
              {String(u.title)}
              {u.event_start ? <span className="ml-2 text-xs text-gray-500">{fmtDate(String(u.event_start))}</span> : null}
              <span className="ml-2 text-xs text-gray-500">строк: {String(u.rows_total)}</span>
            </div>
            <button type="button" onClick={() => remove(u.id)} className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" aria-label="Удалить">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Libraries({ onError, onSendersChanged }: { onError: (m: string) => void; onSendersChanged: () => void }) {
  const [data, setData] = useState<Record<TableKey, Rec[]> | null>(null);
  const [uploads, setUploads] = useState<Rec[]>([]);

  const load = useCallback(async () => {
    try {
      const [libs, ups] = await Promise.all([
        api<Record<TableKey, Rec[]>>(`${API}/libraries`),
        api<{ uploads: Rec[] }>(`${API}/uploads`),
      ]);
      setData(libs);
      setUploads(ups.uploads ?? []);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не удалось загрузить библиотеки');
    }
  }, [onError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!data) return <div className="text-sm text-gray-500">Загрузка…</div>;
  return (
    <div className="space-y-5">
      <LibrarySection table="cases" rows={data.cases} onChanged={load} onError={onError} />
      <LibrarySection table="claims" rows={data.claims} onChanged={load} onError={onError} />
      <LibrarySection
        table="senders"
        rows={data.senders}
        onChanged={() => {
          void load();
          onSendersChanged();
        }}
        onError={onError}
      />
      <UploadsSection uploads={uploads} onChanged={load} onError={onError} />
    </div>
  );
}
