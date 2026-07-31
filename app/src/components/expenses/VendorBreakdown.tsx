'use client';

import { useRef, useState } from 'react';

import { expensesFetch, formatCurrencyMap, formatDelta, formatMoney, formatRub } from '@/lib/expenses/client';
import { categoryLabel, sourceLabel } from '@/lib/expenses/labels';
import type { ExpenseRow, VendorBreakdownItem } from '@/lib/expenses/types';

const TOP_N = 15;

interface DrillPage {
  items: ExpenseRow[];
  total: number;
}

function rowKey(item: VendorBreakdownItem): string {
  return item.vendorId ?? 'unclassified';
}

/** Операции без курса ЦБ: в рублёвую сумму они не вошли, и молчать об этом нельзя. */
function UnconvertedNote({ item }: { item: VendorBreakdownItem }) {
  if (item.unconvertedCount === 0) return null;
  return (
    <span
      className="ml-1.5 whitespace-nowrap rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800"
      title="Для этих операций не нашёлся курс ЦБ — в рублёвую сумму слева они не входят."
    >
      +{item.unconvertedCount} без курса: {formatCurrencyMap(item.unconvertedByCurrency)}
    </span>
  );
}

export default function VendorBreakdown({
  items,
  query,
  queueQuery,
}: {
  items: VendorBreakdownItem[];
  /** from/to/groupBy/source/category — то же окно, что у сводки. */
  query: string;
  /** from/to/source — для строки «Без вендора»: её операции лежат в очереди разметки. */
  queueQuery: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Быстрые клики по разным вендорам иначе дают гонку: ответ на прошлый запрос
  // может прийти позже свежего и подменить содержимое раскрытой строки.
  const requestRef = useRef(0);

  const withBars = items.filter((item) => item.total > 0).slice(0, TOP_N);
  const max = withBars[0]?.total ?? 0;

  async function fetchPage(item: VendorBreakdownItem, nextPage: number): Promise<DrillPage> {
    if (item.vendorId === null) {
      // У неразмеченных строк vendor_id пуст, а `?vendorId=` роут транзакций
      // читает как «фильтра нет» и вернул бы вообще всё. Их список отдаёт
      // очередь разметки — она же отсортирована по убыванию суммы.
      return expensesFetch<DrillPage>(`/unclassified?${queueQuery}`);
    }
    return expensesFetch<DrillPage>(
      `/transactions?${query}&vendorId=${encodeURIComponent(item.vendorId)}&page=${nextPage}`,
    );
  }

  async function toggle(item: VendorBreakdownItem) {
    const key = rowKey(item);
    if (openKey === key) {
      setOpenKey(null);
      return;
    }

    const requestId = ++requestRef.current;
    setOpenKey(key);
    setRows([]);
    setTotal(0);
    setPage(0);
    setError(null);
    setLoading(true);
    try {
      const res = await fetchPage(item, 0);
      if (requestRef.current !== requestId) return;
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      if (requestRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : 'Не удалось загрузить операции');
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }

  async function loadMore(item: VendorBreakdownItem) {
    const requestId = ++requestRef.current;
    const nextPage = page + 1;
    setLoading(true);
    try {
      const res = await fetchPage(item, nextPage);
      if (requestRef.current !== requestId) return;
      setRows((prev) => [...prev, ...res.items]);
      setPage(nextPage);
    } catch (e) {
      if (requestRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : 'Не удалось загрузить операции');
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">Разбивка по сервисам</h3>

      {items.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-zinc-400">Трат за выбранный период нет.</div>
      ) : (
        <>
          <div className="space-y-1.5">
            {withBars.map((item) => (
              <div key={rowKey(item)} className="flex items-center gap-2">
                <span className="w-32 shrink-0 truncate text-xs text-zinc-700 sm:w-44" title={item.vendorName}>
                  {item.vendorName}
                </span>
                <span className="h-3.5 flex-1 rounded bg-zinc-100">
                  <span
                    className="block h-3.5 rounded bg-emerald-700"
                    style={{ width: max > 0 ? `${(item.total / max) * 100}%` : '0%' }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-zinc-900 sm:w-28">
                  {formatRub(item.total)} ₽
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="py-2 font-medium">Вендор</th>
                  <th className="py-2 font-medium">Категория</th>
                  <th className="py-2 text-right font-medium">Сумма</th>
                  <th className="py-2 text-right font-medium">Доля</th>
                  <th className="py-2 text-right font-medium">Операций</th>
                  <th className="py-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const key = rowKey(item);
                  const open = openKey === key;
                  return (
                    <RowGroup
                      key={key}
                      item={item}
                      open={open}
                      rows={open ? rows : []}
                      total={open ? total : 0}
                      loading={open && loading}
                      error={open ? error : null}
                      onToggle={() => void toggle(item)}
                      onLoadMore={() => void loadMore(item)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function RowGroup({
  item,
  open,
  rows,
  total,
  loading,
  error,
  onToggle,
  onLoadMore,
}: {
  item: VendorBreakdownItem;
  open: boolean;
  rows: ExpenseRow[];
  total: number;
  loading: boolean;
  error: string | null;
  onToggle: () => void;
  onLoadMore: () => void;
}) {
  const deltaColor =
    item.deltaPrev === null
      ? 'text-zinc-400'
      : item.deltaPrev > 0
        ? 'text-rose-600'
        : item.deltaPrev < 0
          ? 'text-emerald-600'
          : 'text-zinc-400';

  return (
    <>
      <tr className="border-t border-zinc-100 align-top">
        <td className="py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="text-left text-emerald-800 hover:underline"
          >
            {open ? '▾ ' : '▸ '}
            {item.vendorName}
          </button>
          {item.total === 0 ? (
            <span className="ml-1.5 text-[10px] text-zinc-400">в этом периоде трат нет</span>
          ) : null}
        </td>
        <td className="py-2 text-zinc-600">{item.category ? categoryLabel(item.category) : '—'}</td>
        <td className="py-2 text-right tabular-nums text-zinc-900">
          {formatRub(item.total)} ₽
          <UnconvertedNote item={item} />
        </td>
        <td className="py-2 text-right tabular-nums text-zinc-600">{Math.round(item.share * 100)}%</td>
        <td className="py-2 text-right tabular-nums text-zinc-600">{item.ops}</td>
        <td className={`py-2 text-right tabular-nums ${deltaColor}`}>{formatDelta(item.deltaPrev)}</td>
      </tr>

      {open ? (
        <tr className="border-t border-zinc-50">
          <td colSpan={6} className="px-2 pb-3">
            <div className="rounded-lg border-l-2 border-zinc-200 bg-zinc-50/60 px-3 py-2">
              {item.vendorId === null ? (
                <p className="mb-1.5 text-[11px] text-zinc-500">
                  Неразмеченные операции периода, самые крупные сверху. Фильтр по категории к ним неприменим —
                  категории у них ещё нет.
                </p>
              ) : null}

              {error ? <div className="text-xs text-red-600">{error}</div> : null}
              {loading && rows.length === 0 ? <div className="text-xs text-zinc-400">Загружаю…</div> : null}
              {!loading && !error && rows.length === 0 ? (
                <div className="text-xs text-zinc-400">Операций нет.</div>
              ) : null}

              <div className="space-y-1">
                {rows.map((row) => (
                  <div key={`${row.source}:${row.source_ref}`} className="text-[11px] text-zinc-600">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="tabular-nums text-zinc-500">{row.occurred_on_msk}</span>
                      <span className="text-zinc-400">{sourceLabel(row.source)}</span>
                      <span className="font-medium text-zinc-700">{row.counterparty ?? '—'}</span>
                      {row.counterparty_inn ? (
                        <span className="text-zinc-400">ИНН {row.counterparty_inn}</span>
                      ) : null}
                      <span className="ml-auto shrink-0 tabular-nums text-zinc-900">
                        {row.amount_rub === null ? (
                          <span className="text-amber-700">
                            {formatMoney(row.amount, row.currency)} · курса ЦБ нет
                          </span>
                        ) : (
                          <>
                            {formatRub(row.amount_rub)} ₽
                            {row.currency !== 'RUB' ? (
                              <span className="ml-1 text-zinc-400">({formatMoney(row.amount, row.currency)})</span>
                            ) : null}
                          </>
                        )}
                      </span>
                    </div>
                    {row.details ? <div className="text-zinc-400">{row.details}</div> : null}
                  </div>
                ))}
              </div>

              {rows.length > 0 ? (
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
                  <span>
                    Показано {rows.length} из {total}
                  </span>
                  {item.vendorId !== null && rows.length < total ? (
                    <button
                      type="button"
                      onClick={onLoadMore}
                      disabled={loading}
                      className="rounded-full border border-zinc-200 px-2 py-0.5 text-zinc-600 hover:bg-white disabled:opacity-40"
                    >
                      {loading ? 'Загружаю…' : 'Показать ещё'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
