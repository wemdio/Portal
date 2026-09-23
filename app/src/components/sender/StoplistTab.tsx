'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Search, ShieldOff, Trash2, Upload } from 'lucide-react';
import { readXlsxRows } from '@/lib/spreadsheet/parseCSV';
import { addSuppressionList, addSuppressions, fetchSuppressions, removeSuppression, type SuppressionDto } from './api';

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Адреса из файла стоп-листа. Колонку не угадываем: выгрузки бывают из
 * разных систем с разными заголовками, а адрес в любой ячейке — это адрес,
 * который писать нельзя.
 */
async function emailsFromFile(file: File): Promise<string[]> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const text = ext === 'xlsx' || ext === 'xls'
    ? (await readXlsxRows(await file.arrayBuffer())).map((row) => row.join(' ')).join('\n')
    : await file.text();
  return [...new Set((text.match(EMAIL_IN_TEXT) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, '')))];
}

const SEARCH_DEBOUNCE_MS = 300;

const REASON_LABELS: Record<string, string> = {
  hard_bounce: 'отбойник',
  unsubscribe: 'отписка',
  manual: 'вручную',
  complaint: 'жалоба',
};

/**
 * Стоп-лист (задача 5.3 хендоффа фич): посмотреть, найти, добавить руками
 * (одним адресом или списком), снять адрес. Пополняется автоматически —
 * отбойники, отказы SMTP, «стоп» в ответе; здесь управление поверх.
 */
export function StoplistTab() {
  const [rows, setRows] = useState<SuppressionDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(
    async (targetPage: number) => {
      try {
        const res = await fetchSuppressions({ page: targetPage, search: appliedSearch || undefined });
        setRows(res.suppressions);
        setTotal(res.total);
        setPageSize(res.pageSize);
        if (res.suppressions.length === 0 && res.total > 0 && targetPage > 1) {
          setPage(Math.max(1, Math.ceil(res.total / res.pageSize)));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить стоп-лист');
      } finally {
        setLoading(false);
      }
    },
    [appliedSearch],
  );

  useEffect(() => {
    setLoading(true);
    void load(page).finally(() => setLoading(false));
  }, [load, page]);

  useEffect(() => () => {
    if (timer) window.clearTimeout(timer);
  }, [timer]);

  const onSearch = (value: string) => {
    setSearch(value);
    if (timer) window.clearTimeout(timer);
    setTimer(window.setTimeout(() => {
      setAppliedSearch(value.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS));
  };

  const add = async () => {
    const input = addText.trim();
    if (!input) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await addSuppressions(input);
      setNotice(
        `Добавлено в стоп-лист: ${res.imported}${res.skippedExisting ? ` (уже стояли: ${res.skippedExisting})` : ''}.`,
      );
      setAddText('');
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить');
    } finally {
      setAdding(false);
    }
  };

  const addFromFile = async (file: File) => {
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const emails = await emailsFromFile(file);
      if (!emails.length) {
        setError(`В файле «${file.name}» не нашлось ни одного адреса.`);
        return;
      }
      const res = await addSuppressionList(emails, `Файл: ${file.name}`);
      setNotice(
        `Из файла «${file.name}» добавлено в стоп-лист: ${res.imported} из ${emails.length}`
          + `${res.skippedExisting ? ` (уже стояли: ${res.skippedExisting})` : ''}.`,
      );
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setAdding(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const remove = async (email: string) => {
    if (!window.confirm(`Вернуть ${email} в рассылку? Новые кампании смогут ему писать.`)) return;
    setError(null);
    try {
      await removeSuppression(email);
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось снять адрес');
    }
  };

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
          <ShieldOff className="h-4 w-4 text-zinc-400" />
          Добавить в стоп-лист
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Один адрес или список — каждый с новой строки или через запятую, либо файлом (CSV, TXT, Excel):
          из файла берутся все адреса, в какой бы колонке они ни стояли. Адрес не получает новых писем ни
          в одной кампании.
        </p>
        <div className="mt-3 flex flex-wrap items-start gap-3">
          <textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            rows={2}
            placeholder={'lead@firm.ru\nещё@другая.ком'}
            className="min-w-64 flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={adding || !addText.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Добавить
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void addFromFile(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={adding}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            Загрузить файл
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Стоп-лист ({total})</h2>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Поиск по адресу"
              className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">
            {appliedSearch ? 'Под поиск не попал ни один адрес.' : 'Стоп-лист пуст.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="py-2 pl-5 pr-3 font-medium">Адрес</th>
                <th className="py-2 pr-3 font-medium">Причина</th>
                <th className="py-2 pr-3 font-medium">Добавлен</th>
                <th className="py-2 pr-3 font-medium">Заметка</th>
                <th className="py-2 pr-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.email} className="border-b border-zinc-100 last:border-0">
                  <td className="py-2 pl-5 pr-3 font-medium text-zinc-900">{row.email}</td>
                  <td className="py-2 pr-3 text-zinc-600">{REASON_LABELS[row.reason] ?? row.reason}</td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">
                    {new Date(row.created_at).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">{row.note ?? '—'}</td>
                  <td className="py-2 pr-5 text-right">
                    <button
                      type="button"
                      onClick={() => void remove(row.email)}
                      title="Снять со стоп-листа"
                      aria-label={`Снять ${row.email}`}
                      className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {total > pageSize ? (
          <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-zinc-500">Стр. {page} из {maxPage} · {total}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage || loading}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
