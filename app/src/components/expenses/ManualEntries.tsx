'use client';

import { useEffect, useState } from 'react';

import ManualEntryModal, { type ManualKind } from '@/components/expenses/ManualEntryModal';
import { expensesFetch, formatIsoDate, formatMoney } from '@/lib/expenses/client';
import type { ManualEntry, VendorOption } from '@/lib/expenses/types';
import { useUser } from '@/lib/UserProvider';

function matchesSearch(item: ManualEntry, search: string, vendorName: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    item.occurred_on,
    String(item.amount),
    item.currency,
    item.payer,
    item.channel ?? '',
    item.comment ?? '',
    vendorName,
    item.project?.name ?? '',
    item.deal?.name ?? '',
    item.deal ? String(item.deal.amoId) : '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

/**
 * Ручные записи за период — под графиками своей вкладки.
 *
 * Вносятся они кнопками «+ Доход» / «+ Расход» над вкладками, а здесь их
 * находят, правят и удаляют. Правка не украшение: опечатка в сумме — обычное
 * дело для ручного ввода. Права проверяет сервер (автор или админ), поэтому
 * кнопки видны всем — отказ приходит текстом.
 */
export default function ManualEntries({
  kind,
  range,
  refreshKey,
  vendors = [],
  onChanged,
}: {
  kind: ManualKind;
  range: { from: string; to: string };
  /** Растёт, когда запись добавили кнопкой сверху: список перечитывается. */
  refreshKey: number;
  /** Справочник вендоров — только чтобы подписать расход вендором. */
  vendors?: VendorOption[];
  onChanged: () => void;
}) {
  const { userId } = useUser();
  const isIncome = kind === 'income';

  const [items, setItems] = useState<ManualEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ManualEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      setLoading(true);
      try {
        const res = await expensesFetch<{ items: ManualEntry[] }>(
          `${isIncome ? '/incomes/manual' : '/manual'}?from=${range.from}&to=${range.to}`,
          { signal: controller.signal },
        );
        if (!active) return;
        setItems(res.items);
        setError(null);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить ручные записи');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [isIncome, range.from, range.to, refreshKey, reloadKey]);

  const vendorName = (id: string | null | undefined) => (id ? vendors.find((v) => v.id === id)?.name ?? '' : '');

  async function remove(id: string) {
    setError(null);
    try {
      await expensesFetch(`${isIncome ? '/incomes/manual' : '/manual'}/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setReloadKey((prev) => prev + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить запись');
    }
  }

  const visible = items.filter((item) => matchesSearch(item, search, vendorName(item.vendor_id)));

  return (
    <div className="glass-panel p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">{isIncome ? 'Ручные доходы' : 'Ручные расходы'}</h3>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по сумме, дате, проекту"
          aria-label={isIncome ? 'Поиск по ручным доходам' : 'Поиск по ручным расходам'}
          className="w-56 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        />
      </div>
      <p className="mt-0.5 text-[11px] text-zinc-400">
        За выбранный период; добавить — кнопкой «{isIncome ? '+ Доход' : '+ Расход'}» вверху.
      </p>

      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}

      {/* Плотная подложка: на стекле строки просвечивают друг через друга. */}
      <div className="mt-2 overflow-x-auto rounded-lg bg-[var(--glass-rows)]">
        <table className="w-full min-w-[640px] text-xs">
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td className="px-2 py-2 text-zinc-400">Загружаю…</td>
              </tr>
            ) : null}

            {!loading && visible.length === 0 ? (
              <tr>
                <td className="px-2 py-2 text-zinc-400">
                  {items.length === 0
                    ? isIncome
                      ? 'Ручных доходов за период нет.'
                      : 'Ручных расходов за период нет.'
                    : 'Под поиск ничего не подошло.'}
                </td>
              </tr>
            ) : null}

            {visible.map((item) => {
              const who = isIncome
                ? `${item.payer}${item.channel ? ` · ${item.channel}` : ''}`
                : [vendorName(item.vendor_id), item.payer].filter(Boolean).join(' · ');
              return (
                <tr key={item.id} className="border-t border-zinc-100 first:border-t-0">
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-500">
                    {formatIsoDate(item.occurred_on)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right font-medium tabular-nums text-zinc-900">
                    {formatMoney(Number(item.amount), item.currency)}
                  </td>
                  <td className="py-1.5 pl-3 text-zinc-600">
                    <span className="line-clamp-2">{item.comment || '—'}</span>
                    <span className="text-[10px] text-zinc-400">
                      {who}
                      {userId && item.created_by !== userId ? ' · запись другого пользователя' : ''}
                    </span>
                  </td>
                  <td className="py-1.5 pl-3 text-[11px] text-zinc-500">
                    {item.project ? <span className="block truncate">Проект: {item.project.name}</span> : null}
                    {item.deal ? (
                      item.deal.url ? (
                        <a
                          href={item.deal.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-blue-600 hover:underline"
                        >
                          Сделка: {item.deal.name ?? `№ ${item.deal.amoId}`}
                        </a>
                      ) : (
                        <span className="block truncate">Сделка: {item.deal.name ?? `№ ${item.deal.amoId}`}</span>
                      )
                    ) : null}
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(null);
                        setEditing(item);
                      }}
                      className="text-zinc-400 hover:text-zinc-700"
                    >
                      Изменить
                    </button>
                  </td>
                  <td className="py-1.5 pl-2 pr-2 text-right">
                    {confirmDeleteId === item.id ? (
                      <span className="whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void remove(item.id)}
                          className="text-red-600 hover:underline"
                        >
                          Удалить?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="ml-2 text-zinc-400 hover:text-zinc-600"
                        >
                          нет
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(item.id)}
                        className="text-zinc-400 hover:text-red-600"
                      >
                        Удалить
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing ? (
        <ManualEntryModal
          kind={kind}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReloadKey((prev) => prev + 1);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
