'use client';

import { useMemo, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatRub } from '@/lib/expenses/client';
import type { GroupBy } from '@/lib/expenses/period';

/**
 * Столбчатый график по времени — общий у расхода и дохода.
 *
 * Обобщён именно потому, что данные у сторон одной формы: бакет, итог, признак
 * неполноты и разрез `Record<ключ, сумма>`. Что этот ключ значит — категория,
 * источник, что-то ещё — графику знать не нужно, он получает готовые подписи и
 * цвета. Флага «я про доход» здесь нет и быть не должно: всё, что различается,
 * приходит пропсами-листьями, а разрезом управляет вызывающий (у расхода —
 * переключателем в `toolbar`, у дохода его нет вовсе).
 */

export interface StackedPoint {
  bucket: string;
  total: number;
  /**
   * Календарные границы бакета выходят за пределы запрошенного периода —
   * столбец ниже соседних не потому, что денег стало меньше.
   */
  partial: boolean;
  /** Разрез столбца: ключ ряда → сумма в рублях. */
  parts: Record<string, number>;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Ключ бакета — всегда YYYY-MM-DD (начало бакета в МСК). Разбираем строкой:
 *  `new Date(key)` подставил бы часовой пояс браузера и мог бы съехать на день. */
function splitKey(key: string): [string, string, string] | null {
  const [y, m, d] = key.split('-');
  if (!y || !m || !d) return null;
  return [y, m, d];
}

/** Короткая подпись под столбцом. */
function axisLabel(key: string, groupBy: GroupBy): string {
  const parts = splitKey(key);
  if (!parts) return key;
  const [y, m, d] = parts;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  return `${d}.${m}`;
}

/** Полная подпись в тултипе: у недели и месяца видно, какой именно отрезок. */
function fullLabel(key: string, groupBy: GroupBy): string {
  const parts = splitKey(key);
  if (!parts) return key;
  const [y, m, d] = parts;
  if (groupBy === 'day') return `${d}.${m}.${y}`;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  const start = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const dd = String(end.getUTCDate()).padStart(2, '0');
  const mm = String(end.getUTCMonth() + 1).padStart(2, '0');
  return `${d}.${m} — ${dd}.${mm}.${end.getUTCFullYear()}`;
}

interface ChartRow {
  bucket: string;
  label: string;
  partial: boolean;
  total: number;
  [key: string]: string | number | boolean;
}

interface TooltipPayloadItem {
  dataKey?: string | number;
  value?: number;
  color?: string;
  payload?: ChartRow;
}

function ChartTooltip({
  active,
  payload,
  groupBy,
  labelOf,
  zeroText,
  partialNote,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  groupBy: GroupBy;
  labelOf: (key: string) => string;
  zeroText: string;
  partialNote: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  const parts = (payload ?? []).filter((item) => Number(item.value ?? 0) !== 0);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-zinc-900">{fullLabel(row.bucket, groupBy)}</div>
      <div className="mt-1 space-y-0.5">
        {parts.map((item) => (
          <div key={String(item.dataKey)} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="text-zinc-600">{labelOf(String(item.dataKey))}</span>
            <span className="ml-auto tabular-nums text-zinc-900">{formatRub(Number(item.value ?? 0))} ₽</span>
          </div>
        ))}
        {parts.length === 0 ? <div className="text-zinc-400">{zeroText}</div> : null}
      </div>
      <div className="mt-1 flex items-center gap-2 border-t border-zinc-100 pt-1">
        <span className="text-zinc-500">Итого</span>
        <span className="ml-auto tabular-nums font-medium text-zinc-900">{formatRub(row.total)} ₽</span>
      </div>
      {row.partial ? (
        <p className="mt-1.5 max-w-[240px] border-t border-amber-200 pt-1 text-[11px] text-amber-700">
          {partialNote}
        </p>
      ) : null}
    </div>
  );
}

/** Порядок рядов фиксирован, чтобы цвета не прыгали между перерисовками. */
function orderKeys(keys: Set<string>, canonical: readonly string[]): string[] {
  const known = canonical.filter((key) => keys.has(key));
  const unknown = [...keys].filter((key) => !canonical.includes(key)).sort();
  return [...known, ...unknown];
}

export default function StackedTimeChart({
  title,
  points,
  groupBy,
  canonicalOrder,
  labelOf,
  colorOf,
  emptyText,
  zeroBucketText,
  partialTooltip,
  partialFootnote,
  toolbar,
}: {
  title: string;
  points: StackedPoint[];
  groupBy: GroupBy;
  /** Канонический порядок рядов; ключи вне списка уходят в конец по алфавиту. */
  canonicalOrder: readonly string[];
  labelOf: (key: string) => string;
  colorOf: (key: string) => string;
  /** «Трат за выбранный период нет.» / «Поступлений за выбранный период нет.» */
  emptyText: string;
  /** Подпись в тултипе пустого столбца. */
  zeroBucketText: string;
  /** Пояснение к неполному столбцу в тултипе — целиком, чтобы фраза оставалась переводимой. */
  partialTooltip: string;
  /** Хвост сноски под графиком: перед ним подставляются подписи неполных столбцов. */
  partialFootnote: string;
  /** Управление разрезом, если оно у стороны есть. */
  toolbar?: ReactNode;
}) {
  const { data, keys, partialLabels } = useMemo(() => {
    const seen = new Set<string>();
    const rows: ChartRow[] = points.map((point) => {
      for (const key of Object.keys(point.parts)) seen.add(key);
      return {
        ...point.parts,
        bucket: point.bucket,
        label: axisLabel(point.bucket, groupBy),
        partial: point.partial,
        total: point.total,
      };
    });
    return {
      data: rows,
      keys: orderKeys(seen, canonicalOrder),
      partialLabels: rows.filter((row) => row.partial).map((row) => row.label),
    };
  }, [points, groupBy, canonicalOrder]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        {toolbar}
      </div>

      {data.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-zinc-400">{emptyText}</div>
      ) : (
        <div style={{ height: 288 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#a1a1aa' }}
                axisLine={{ stroke: '#e4e4e7' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#a1a1aa' }}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(value: number) => formatRub(value)}
              />
              <Tooltip
                cursor={{ fill: '#fafafa' }}
                content={
                  <ChartTooltip
                    groupBy={groupBy}
                    labelOf={labelOf}
                    zeroText={zeroBucketText}
                    partialNote={partialTooltip}
                  />
                }
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {keys.map((key) => (
                <Bar key={key} dataKey={key} name={labelOf(key)} stackId="a" fill={colorOf(key)}>
                  {/* Неполный бакет рисуется полупрозрачным: календарно он выходит
                      за границы периода, и без пометки низкий столбец читается
                      как провал, хотя данные полные. */}
                  {data.map((row) => (
                    <Cell key={row.bucket} fillOpacity={row.partial ? 0.45 : 1} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {partialLabels.length > 0 ? (
        <p className="mt-2 text-[11px] text-amber-700">
          Полупрозрачные столбцы ({partialLabels.join(', ')}) неполные: {partialFootnote}
        </p>
      ) : null}
    </div>
  );
}
