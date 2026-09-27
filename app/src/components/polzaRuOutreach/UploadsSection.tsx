'use client';

import { useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { API, api, fmtDate } from './shared';
import type { Rec } from './libraryFilters';

const inputCls =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';

type Kind = 'exhibitors' | 'contracts' | 'growth' | 'tenders';

const KIND_LABELS: Record<Kind, string> = {
  exhibitors: 'выставка',
  contracts: 'контракты',
  growth: 'гранты',
  tenders: 'тендеры',
};

export function UploadsSection({ uploads, onChanged, onError }: { uploads: Rec[]; onChanged: () => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<Kind>('exhibitors');
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
      <div className="text-base font-semibold text-gray-900">Файлы сигналов: выставки, госконтракты, гранты</div>
      <p className="mt-0.5 max-w-3xl text-sm text-gray-500">
        Каталог участников выставки (с официального сайта), выгрузка результатов поиска контрактов из ЕИС или список получателей грантов /
        участников акселератора (Сколково, ФРИИ и т.п.) — Excel или CSV. Нужна колонка с названием компании; сайт, ИНН, дата, предмет, сумма и
        заказчик распознаются по заголовкам.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="exhibitors">Каталог выставки</option>
          <option value="contracts">Выгрузка контрактов ЕИС</option>
          <option value="tenders">Выгрузка коммерческих тендеров (B2B-Center, Росэлторг)</option>
          <option value="growth">Список грантов / акселератора</option>
        </select>
        <input
          className={inputCls}
          placeholder={kind === 'exhibitors' ? 'Название выставки' : kind === 'growth' ? 'Название программы (попадёт в письмо)' : 'Название выгрузки'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
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
          onClick={() => void upload()}
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
              <span className="mr-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{KIND_LABELS[u.kind as Kind] ?? String(u.kind)}</span>
              {String(u.title)}
              {u.event_start ? <span className="ml-2 text-xs text-gray-500">{fmtDate(String(u.event_start))}</span> : null}
              <span className="ml-2 text-xs text-gray-500">строк: {String(u.rows_total)}</span>
            </div>
            <button
              type="button"
              onClick={() => void remove(u.id)}
              className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
              aria-label="Удалить"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
