'use client';

import { useEffect, useState } from 'react';

import { expensesFetch, formatMoney, formatRub } from '@/lib/expenses/client';
import { sourceLabel } from '@/lib/expenses/labels';
import type { IncomeRow } from '@/lib/expenses/types';

/**
 * Постраничный список приходов.
 *
 * Один компонент на оба места, где доходная вкладка показывает операции
 * построчно — раскрытого плательщика и разбор не-выручки. Различаются они
 * ровно строкой запроса, а всё остальное — эндпоинт, форма ответа, пагинация —
 * общее. Флага «я про не-выручку» здесь нет: причина исключения рисуется
 * тогда, когда она есть в самой строке.
 */

interface OperationsPage {
  items: IncomeRow[];
  total: number;
}

interface Props {
  /** Query-строка для `/api/expenses/incomes/transactions` без `page`. */
  query: string;
  emptyText: string;
}

/**
 * Смена запроса начинает список с нуля — и накопленные страницы, и номер
 * текущей обязаны сброситься. `key` делает это перемонтированием: правка того
 * же стейта из эффекта дала бы лишний каскад рендеров и гонку между старым
 * ответом и новым запросом, а так старого экземпляра к моменту ответа уже нет.
 */
export default function IncomeOperations(props: Props) {
  return <Operations key={props.query} {...props} />;
}

function Operations({ query, emptyText }: Props) {
  const [rows, setRows] = useState<IncomeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const res = await expensesFetch<OperationsPage>(`/incomes/transactions?${query}&page=0`, {
          signal: controller.signal,
        });
        if (!active) return;
        setRows(res.items);
        setTotal(res.total);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить операции');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [query]);

  async function loadMore() {
    const nextPage = page + 1;
    setLoading(true);
    try {
      const res = await expensesFetch<OperationsPage>(`/incomes/transactions?${query}&page=${nextPage}`);
      setRows((prev) => [...prev, ...res.items]);
      setPage(nextPage);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить операции');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {error ? <div className="text-xs text-red-600">{error}</div> : null}
      {loading && rows.length === 0 ? <div className="text-xs text-zinc-400">Загружаю…</div> : null}
      {!loading && !error && rows.length === 0 ? (
        <div className="text-xs text-zinc-400">{emptyText}</div>
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
              {/* Причина есть только у не-выручки — она же и объясняет, почему
                  строка видна, но в доход не вошла. */}
              {row.exclude_reason ? (
                <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500">
                  {row.exclude_reason}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 tabular-nums text-zinc-900">
                {row.amount_rub === null ? (
                  <span className="text-amber-700">{formatMoney(row.amount, row.currency)} · курса ЦБ нет</span>
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
          {rows.length < total ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loading}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-zinc-600 hover:bg-white disabled:opacity-40"
            >
              {loading ? 'Загружаю…' : 'Показать ещё'}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
