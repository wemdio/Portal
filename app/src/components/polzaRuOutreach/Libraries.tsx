'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { INDUSTRY_GROUPS, INDUSTRY_GROUP_LABELS } from '@/lib/polzaRuOutreach/types';
import { LibraryRecordForm } from './LibraryRecordForm';
import { UploadsSection } from './UploadsSection';
import { WorkArea } from './WorkArea';
import { TABLE_META, statusLabel, statusOptionsFor, type TableKey } from './libraryFields';
import {
  EMPTY_QUERY,
  MIN_CASE_LEADS,
  applyListQuery,
  isBelowLeadBar,
  leadsOf,
  paginate,
  type ListQuery,
  type Rec,
  type SortKey,
} from './libraryFilters';
import { API, api, fmtDate } from './shared';

type SectionKey = TableKey | 'uploads';

const inputCls =
  'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';

const SORT_OPTIONS: Array<[SortKey, string]> = [
  ['default', 'Порядок по умолчанию'],
  ['name', 'По названию'],
  ['updated', 'Сначала изменённые'],
];

const CASE_SORT_OPTIONS: Array<[SortKey, string]> = [
  ['default', 'Порядок по умолчанию'],
  ['leads_desc', 'Лидов больше'],
  ['leads_asc', 'Лидов меньше'],
  ['name', 'По названию'],
  ['updated', 'Сначала изменённые'],
];

function Badge({ tone, children }: { tone: 'ok' | 'muted' | 'warn'; children: React.ReactNode }) {
  const cls =
    tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : tone === 'warn' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600';
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

function LibrarySection({
  table,
  rows,
  onChanged,
  onError,
}: {
  table: TableKey;
  rows: Rec[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const meta = TABLE_META[table];
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const [query, setQuery] = useState<ListQuery>(EMPTY_QUERY);
  const [pageRaw, setPage] = useState(0);

  const filtered = useMemo(() => applyListQuery(rows, query, meta.searchFields), [rows, query, meta.searchFields]);
  const { rows: pageRows, page, totalPages, from } = paginate(filtered, pageRaw);

  const patch = (part: Partial<ListQuery>) => {
    setQuery((prev) => ({ ...prev, ...part }));
    setPage(0);
  };

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

  const sortOptions = meta.isCases ? CASE_SORT_OPTIONS : SORT_OPTIONS;
  const filtersOn = query.query !== '' || query.status !== '' || query.industry !== '';

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 p-5">
        <div>
          <div className="text-base font-semibold text-gray-900">{meta.title}</div>
          <p className="mt-0.5 max-w-3xl text-sm text-gray-500">{meta.hint}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="inline-flex shrink-0 items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
        >
          <Plus className="mr-1 h-4 w-4" /> Добавить
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-5 py-3">
        <span className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            className={`${inputCls} w-full pl-8`}
            placeholder={meta.searchPlaceholder}
            value={query.query}
            onChange={(e) => patch({ query: e.target.value })}
          />
        </span>
        <select className={inputCls} value={query.status} onChange={(e) => patch({ status: e.target.value })}>
          <option value="">Любой статус</option>
          {statusOptionsFor(table).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {meta.isCases && (
          <select className={inputCls} value={query.industry} onChange={(e) => patch({ industry: e.target.value })}>
            <option value="">Любая отрасль</option>
            {INDUSTRY_GROUPS.map((g) => (
              <option key={g} value={g}>
                {INDUSTRY_GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        )}
        <select className={inputCls} value={query.sort} onChange={(e) => patch({ sort: e.target.value as SortKey })}>
          {sortOptions.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {filtersOn && (
          <button type="button" onClick={() => patch(EMPTY_QUERY)} className="rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">
            Сбросить
          </button>
        )}
      </div>

      <div className="divide-y divide-gray-100">
        {rows.length === 0 && <div className="px-5 py-4 text-sm text-gray-500">Пока пусто.</div>}
        {rows.length > 0 && filtered.length === 0 && (
          <div className="px-5 py-4 text-sm text-gray-500">Ничего не нашлось. Смягчите фильтры или очистите поиск.</div>
        )}
        {pageRows.map((r) => {
          const belowBar = meta.isCases && isBelowLeadBar(r);
          const leads = leadsOf(r);
          return (
            <div key={r.id} className={`px-5 py-3 ${belowBar ? 'border-l-4 border-amber-300' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">{meta.primary(r) || '—'}</span>
                    {r.case_id ? <span className="font-mono text-xs text-gray-500">{String(r.case_id)}</span> : null}
                    <Badge tone={r.status === 'approved' || r.status === 'active' ? 'ok' : 'muted'}>{statusLabel(table, r.status)}</Badge>
                    {meta.isCases && <Badge tone="muted">{leads === null ? 'лиды не указаны' : `${leads} лидов`}</Badge>}
                    {belowBar && <Badge tone="warn">в письма не идёт: меньше {MIN_CASE_LEADS} лидов</Badge>}
                    {r.is_default ? <Badge tone="muted">по умолчанию</Badge> : null}
                    {r.expires_at ? <span className="text-xs text-gray-500">до {fmtDate(String(r.expires_at))}</span> : null}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-gray-500">{meta.secondary(r)}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" onClick={() => setEditing(r)} className="rounded-md px-2 py-1 text-xs text-violet-700 hover:bg-violet-50">
                    Изменить
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(r.id)}
                    className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    aria-label="Удалить"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3">
          <span className="text-xs text-gray-500">
            {from + 1}–{from + pageRows.length} из {filtered.length}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Назад
            </button>
            <span className="px-1 text-xs text-gray-500">
              стр. {page + 1} из {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
              className="rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Вперёд
            </button>
          </span>
        </div>
      )}

      {editing && (
        <LibraryRecordForm table={table} record={editing === 'new' ? null : editing} onSave={save} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

export function Libraries({ onError, onSendersChanged }: { onError: (m: string) => void; onSendersChanged: () => void }) {
  const [data, setData] = useState<Record<TableKey, Rec[]> | null>(null);
  const [uploads, setUploads] = useState<Rec[]>([]);
  const [section, setSection] = useState<SectionKey>('cases');

  const load = useCallback(async () => {
    try {
      const [libs, ups] = await Promise.all([api<Record<TableKey, Rec[]>>(`${API}/libraries`), api<{ uploads: Rec[] }>(`${API}/uploads`)]);
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

  const counts: Record<SectionKey, number> = {
    cases: data.cases?.length ?? 0,
    claims: data.claims?.length ?? 0,
    senders: data.senders?.length ?? 0,
    uploads: uploads.length,
  };

  const menu: Array<[SectionKey, string]> = [
    ['cases', TABLE_META.cases.short],
    ['claims', TABLE_META.claims.short],
    ['senders', TABLE_META.senders.short],
    ['uploads', 'Файлы сигналов'],
  ];

  return (
    <WorkArea
      aside={
        <nav className="flex gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-2 shadow-sm lg:flex-col lg:overflow-visible">
          {menu.map(([key, title]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              className={`flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm lg:w-full ${
                section === key ? 'bg-violet-50 font-medium text-violet-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span>{title}</span>
              <span className="text-xs text-gray-500">{counts[key]}</span>
            </button>
          ))}
        </nav>
      }
    >
      {section === 'uploads' ? (
        <UploadsSection uploads={uploads} onChanged={load} onError={onError} />
      ) : (
        <LibrarySection
          table={section}
          rows={data[section] ?? []}
          onChanged={() => {
            void load();
            if (section === 'senders') onSendersChanged();
          }}
          onError={onError}
        />
      )}
    </WorkArea>
  );
}
