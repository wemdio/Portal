'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { fetchMailboxes, type MailboxDto } from './api';
import { MAILBOX_STATUS_LABELS, providerLabel } from './labels';
import { SenderModal } from './SenderModal';

/** Ящик в выборке: адрес храним рядом с id, чтобы показать его без повторного запроса. */
export interface PickedMailbox {
  id: string;
  email: string;
}

const PAGE_SIZE = 200;
/** Пауза перед запросом: человек печатает домен, а не отправляет запрос на каждую букву. */
const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  initial: PickedMailbox[];
  onSave: (picked: PickedMailbox[]) => void;
  onClose: () => void;
}

/**
 * Выбор ящиков для кампании.
 *
 * Ящиков бывает несколько сотен, поэтому это поиск, а не список: строка фильтрует
 * по адресу на стороне БД, выбранное живёт отдельно от результатов поиска и
 * переживает смену запроса. Ящик не в статусе «Готов» выбрать можно — отправка
 * всё равно берёт только проверенные, и такой ящик просто подключится к
 * кампании сам, когда пройдёт проверку.
 */
export function MailboxPickerModal({ initial, onSave, onClose }: Props) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MailboxDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedMailbox[]>(initial);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchMailboxes({ search: query, pageSize: PAGE_SIZE });
        if (cancelled) return;
        setRows(res.mailboxes);
        setTotal(res.total);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить ящики');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  const pickedIds = useMemo(() => new Set(picked.map((m) => m.id)), [picked]);
  const allShownPicked = rows.length > 0 && rows.every((row) => pickedIds.has(row.id));

  const toggle = (mailbox: MailboxDto) => {
    setPicked((prev) =>
      prev.some((m) => m.id === mailbox.id)
        ? prev.filter((m) => m.id !== mailbox.id)
        : [...prev, { id: mailbox.id, email: mailbox.email }],
    );
  };

  const toggleShown = () => {
    setPicked((prev) => {
      if (allShownPicked) {
        const shown = new Set(rows.map((r) => r.id));
        return prev.filter((m) => !shown.has(m.id));
      }
      const known = new Set(prev.map((m) => m.id));
      return [...prev, ...rows.filter((r) => !known.has(r.id)).map((r) => ({ id: r.id, email: r.email }))];
    });
  };

  return (
    <SenderModal
      title="Ящики для отправки"
      subtitle="Письма кампании уходят по очереди со всех выбранных ящиков"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-sm text-zinc-500">Выбрано: {picked.length}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => onSave(picked)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            Сохранить
          </button>
        </>
      }
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          placeholder="Поиск по адресу: домен, имя, часть адреса"
          className="w-full rounded-xl border border-zinc-300 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {loading ? 'Загружаю…' : `Найдено: ${total}`}
          {!loading && total > rows.length ? ` · показаны первые ${rows.length}, уточните поиск` : ''}
        </span>
        {rows.length ? (
          <button
            type="button"
            onClick={toggleShown}
            className="rounded-lg px-2.5 py-1.5 text-xs text-blue-600 transition-colors hover:bg-blue-50"
          >
            {allShownPicked ? 'Снять показанные' : 'Выбрать показанные'}
          </button>
        ) : null}
      </div>

      <div className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            {query ? 'Ничего не нашлось — попробуйте другой кусок адреса.' : 'Ящиков пока нет — подключите их на вкладке «Ящики».'}
          </p>
        ) : (
          rows.map((mailbox) => {
            const status = MAILBOX_STATUS_LABELS[mailbox.status];
            const active = pickedIds.has(mailbox.id);
            return (
              <label
                key={mailbox.id}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors ${
                  active ? 'bg-blue-50/60' : 'hover:bg-zinc-100'
                }`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(mailbox)}
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{mailbox.email}</span>
                <span className="hidden text-xs text-zinc-400 sm:block">{providerLabel(mailbox.provider)}</span>
                <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.text}</span>
              </label>
            );
          })
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
    </SenderModal>
  );
}
