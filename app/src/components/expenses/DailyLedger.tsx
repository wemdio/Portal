'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react';

import type { DayGroup } from '@/lib/expenses/byDay';
import { expensesFetch, formatMoney, formatRub, pluralOps } from '@/lib/expenses/client';
import { categoryLabel, sourceLabel } from '@/lib/expenses/labels';
import type { ExpenseRow, IncomeRow } from '@/lib/expenses/types';

/**
 * Раскрывающийся список операций по дням — общий для расхода и прихода.
 *
 * Графики отвечают «сколько», разбивки — «кому и от кого суммарно», а этот
 * список отвечает на вопрос, ради которого раньше выгружали Excel: «что именно
 * ушло 19 августа». День свёрнут в строку с итогом, разворачивается щелчком.
 *
 * Сортировка — по любому столбцу, и у дней, и у операций внутри дня. Считается
 * на клиенте: период уже пришёл целиком (см. /api/expenses/by-day), и ходить на
 * сервер за каждым щелчком по заголовку незачем.
 */

type Row = ExpenseRow | IncomeRow;

interface Props {
  kind: 'expenses' | 'incomes';
  /** Query-строка периода и фильтров, без ведущего `?`. */
  query: string;
}

type DaySortKey = 'date' | 'count' | 'total';
type SortDir = 'asc' | 'desc';

/** Колонки операций внутри дня — свои у расхода и у прихода. */
const ROW_COLUMNS = {
  expenses: [
    { key: 'counterparty', label: 'Контрагент', numeric: false },
    { key: 'vendor', label: 'Вендор', numeric: false },
    { key: 'category', label: 'Категория', numeric: false },
    { key: 'source', label: 'Источник', numeric: false },
    { key: 'details', label: 'Назначение', numeric: false },
    { key: 'amount', label: 'Сумма', numeric: true },
  ],
  incomes: [
    { key: 'counterparty', label: 'Плательщик', numeric: false },
    { key: 'inn', label: 'ИНН', numeric: false },
    { key: 'source', label: 'Источник', numeric: false },
    { key: 'details', label: 'Назначение', numeric: false },
    { key: 'revenue', label: 'Выручка', numeric: false },
    { key: 'amount', label: 'Сумма', numeric: true },
  ],
} as const;

type RowSortKey = (typeof ROW_COLUMNS)[keyof typeof ROW_COLUMNS][number]['key'];

/** Значение ячейки для сортировки: число — у сумм, строка — у остального. */
function cellValue(row: Row, key: RowSortKey): string | number {
  switch (key) {
    case 'amount':
      return row.amount_rub ?? row.amount;
    case 'counterparty':
      return row.counterparty ?? '';
    case 'details':
      return row.details ?? '';
    case 'source':
      return sourceLabel(row.source);
    case 'vendor':
      return (row as ExpenseRow).vendor_name ?? '';
    case 'category': {
      const category = (row as ExpenseRow).category;
      return category ? categoryLabel(category) : '';
    }
    case 'inn':
      return row.counterparty_inn ?? '';
    case 'revenue': {
      const isRevenue = (row as IncomeRow).is_revenue;
      // Пусто — это третье состояние («классификатор не решал»), и в сортировке
      // оно обязано отличаться от «нет», а не сливаться с ним.
      return isRevenue === null ? '' : isRevenue ? 'да' : 'нет';
    }
    default:
      return '';
  }
}

function compare(a: string | number, b: string | number, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
  // localeCompare с 'ru': иначе «Ё» и строчные буквы уезжают в конец списка.
  return String(a).localeCompare(String(b), 'ru') * sign;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 text-zinc-300" />;
  return dir === 'asc'
    ? <ArrowUp className="h-3 w-3 text-zinc-500" />
    : <ArrowDown className="h-3 w-3 text-zinc-500" />;
}

const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', timeZone: 'UTC' });

/** `2026-08-19` → `19.08.2026, среда`. */
function formatDay(date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  // Полдень по UTC, а не полночь: у полуночи любой сдвиг зоны уводит день назад.
  const weekday = WEEKDAY.format(new Date(`${date}T12:00:00.000Z`));
  return `${d}.${m}.${y}, ${weekday}`;
}

export default function DailyLedger({ kind, query }: Props) {
  const [days, setDays] = useState<DayGroup<Row>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [daySort, setDaySort] = useState<{ key: DaySortKey; dir: SortDir }>({ key: 'date', dir: 'desc' });
  const [rowSort, setRowSort] = useState<{ key: RowSortKey; dir: SortDir }>({ key: 'amount', dir: 'desc' });

  const path = kind === 'expenses' ? '/by-day' : '/incomes/by-day';

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      setLoading(true);
      try {
        const res = await expensesFetch<{ days: DayGroup<Row>[] }>(`${path}?${query}`, {
          signal: controller.signal,
        });
        if (!active) return;
        setDays(res.days);
        setError(null);
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
  }, [path, query]);

  const sortedDays = useMemo(() => {
    const value = (day: DayGroup<Row>): string | number =>
      daySort.key === 'date' ? day.date : daySort.key === 'count' ? day.count : day.total;
    return [...days].sort((a, b) => compare(value(a), value(b), daySort.dir));
  }, [days, daySort]);

  const periodTotal = useMemo(() => days.reduce((sum, d) => sum + d.total, 0), [days]);
  const periodOps = useMemo(() => days.reduce((sum, d) => sum + d.count, 0), [days]);

  const toggle = (date: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  // Первый щелчок по столбцу — по убыванию: и у дат, и у сумм интереснее
  // сначала свежее и крупное. Повторный переключает направление.
  const sortDaysBy = (key: DaySortKey) => {
    setDaySort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  const sortRowsBy = (key: RowSortKey) => {
    setRowSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  const columns = ROW_COLUMNS[kind];
  const title = kind === 'expenses' ? 'Расходы по дням' : 'Приходы по дням';

  if (loading) return <div className="glass-tile p-4 text-xs text-zinc-400">Загрузка операций…</div>;
  if (error) return <div className="glass-tile p-4 text-xs text-rose-600">{error}</div>;
  if (days.length === 0) {
    return <div className="glass-tile p-4 text-xs text-zinc-400">За период операций нет.</div>;
  }

  const dayHeader = (key: DaySortKey, label: string, align: 'left' | 'right') => (
    <button
      type="button"
      onClick={() => sortDaysBy(key)}
      className={`inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-800 cursor-pointer ${align === 'right' ? 'justify-end' : ''}`}
    >
      {label}
      <SortIcon active={daySort.key === key} dir={daySort.dir} />
    </button>
  );

  return (
    <div className="glass-tile overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-800">{title}</h3>
        <span className="text-[11px] text-zinc-500">
          {pluralOps(periodOps)} · {formatRub(periodTotal)}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-zinc-100 px-4 py-2">
        {dayHeader('date', 'День', 'left')}
        {dayHeader('count', 'Операций', 'right')}
        {dayHeader('total', 'Сумма', 'right')}
      </div>

      <div className="divide-y divide-zinc-100">
        {sortedDays.map((day) => {
          const open = expanded.has(day.date);
          const rows = open
            ? [...day.items].sort((a, b) =>
                compare(cellValue(a, rowSort.key), cellValue(b, rowSort.key), rowSort.dir))
            : [];
          return (
            <div key={day.date}>
              <button
                type="button"
                onClick={() => toggle(day.date)}
                className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-2.5 text-left transition hover:bg-zinc-50 cursor-pointer"
              >
                <span className="flex items-center gap-2 text-xs text-zinc-800">
                  {open
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />}
                  {formatDay(day.date)}
                </span>
                <span className="text-right text-xs text-zinc-500">{day.count}</span>
                <span className="text-right text-xs font-medium text-zinc-900">
                  {formatRub(day.total)}
                  {day.withoutRate > 0 && (
                    <span
                      className="ml-1 text-[10px] font-normal text-amber-600"
                      title="Валютные операции без курса ЦБ — в сумму дня не вошли"
                    >
                      +{day.withoutRate} без курса
                    </span>
                  )}
                </span>
              </button>

              {open && (
                <div className="overflow-x-auto bg-zinc-50/60 px-4 pb-3">
                  <table className="w-full min-w-[720px] text-[11px]">
                    <thead>
                      <tr className="text-left text-zinc-500">
                        {columns.map((c) => (
                          <th key={c.key} className={`py-1.5 pr-3 font-medium ${c.numeric ? 'text-right' : ''}`}>
                            <button
                              type="button"
                              onClick={() => sortRowsBy(c.key)}
                              className="inline-flex items-center gap-1 transition hover:text-zinc-800 cursor-pointer"
                            >
                              {c.label}
                              <SortIcon active={rowSort.key === c.key} dir={rowSort.dir} />
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200/70">
                      {rows.map((row) => (
                        <tr key={`${row.source}-${row.source_ref}`} className="text-zinc-700">
                          {columns.map((c) => (
                            <td
                              key={c.key}
                              className={`py-1.5 pr-3 align-top ${c.numeric ? 'whitespace-nowrap text-right' : ''}`}
                            >
                              {c.key === 'amount' ? (
                                <>
                                  <span className="font-medium text-zinc-900">
                                    {row.amount_rub === null ? '—' : formatRub(row.amount_rub)}
                                  </span>
                                  {row.currency !== 'RUB' && (
                                    <span className="ml-1 text-zinc-400">
                                      {formatMoney(row.amount, row.currency)}
                                    </span>
                                  )}
                                </>
                              ) : c.key === 'details' ? (
                                <span className="line-clamp-2 text-zinc-500">
                                  {String(cellValue(row, c.key)) || '—'}
                                </span>
                              ) : (
                                String(cellValue(row, c.key)) || '—'
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
