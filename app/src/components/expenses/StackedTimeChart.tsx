'use client';

import { useId, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

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
 *
 * Оформление собрано вручную, а не оставлено на дефолты recharts: столбцы со
 * скруглённой вершиной, зазор между сегментами стека, только горизонтальная
 * сетка, свой тултип поверхностью как у карточек портала. Цвета рядов приходят
 * из `colorOf` как `var(--chart-series-N)` — значения живут в `globals.css`,
 * потому что иначе тёмная тема до них не дотягивается.
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

/** Скругление свободного конца столбца. У основания угол остаётся прямым. */
const BAR_RADIUS = 4;

/** Зазор между сегментами стека — стек должен читаться как набор частей. */
const STACK_GAP = 2;

/** Ниже этого сегмент не режем: у тонкой полоски зазор съел бы её целиком. */
const MIN_SEGMENT_HEIGHT = 1.5;

/** Столбец не должен разъезжаться в плиту, когда бакетов в периоде два-три. */
const MAX_BAR_WIDTH = 44;

/**
 * Оси, сетка и подсветка наведения заданы нейтральным серым с прозрачностью, а
 * не переменной темы: полупрозрачный серый одинаково спокойно ложится и на
 * белую карточку, и на тёмную поверхность, и не требует второго набора
 * значений. Цвета рядов — другое дело, они в CSS-переменных.
 */
const GRID_LINE = 'rgba(127, 127, 133, 0.22)';
const AXIS_LINE = 'rgba(127, 127, 133, 0.35)';
const AXIS_TEXT = 'rgba(127, 127, 133, 0.95)';
const HOVER_BAND = 'rgba(127, 127, 133, 0.1)';

/**
 * Размер подписи продублирован в `style`, и именно строкой с единицами.
 *
 * Чтобы решить, переносить ли подпись, recharts меряет её ширину скрытым
 * span-ом, а стиль для замера копирует через `Object.assign(el.style, …)` —
 * туда доезжает только `style`, и только валидным CSS. С размером в одном лишь
 * атрибуте (или числом) замер идёт по 16px: «550 тыс» не влезает в ширину оси
 * и рвётся на две строки, хотя нарисовано будет одиннадцатым кеглем.
 */
const AXIS_TICK = { fontSize: 11, fill: AXIS_TEXT, style: { fontSize: '11px' } };

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToMotionPreference(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Появление столбцов — украшение, и пользователь вправе от него отказаться.
 * `useSyncExternalStore`, а не эффект со `setState`: на сервере значение
 * неизвестно, и честнее отдать «анимация разрешена», чем моргнуть состоянием.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

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

/**
 * Подпись деления оси. Полная сумма здесь не нужна и мешает: порядок величины
 * читается с «1,2 млн» быстрее, чем с «1 240 000», а точное число всё равно
 * стоит в тултипе и в таблице под графиком.
 */
function axisAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(1).replace(/[.,]0$/, '').replace('.', ',');
    return `${millions} млн`;
  }
  if (abs >= 10_000) return `${Math.round(value / 1000)} тыс`;
  return formatRub(value);
}

interface ChartRow {
  bucket: string;
  label: string;
  partial: boolean;
  total: number;
  [key: string]: string | number | boolean;
}

/** Края стека столбца: у нижнего сегмента не режем низ, у верхнего скругляем верх. */
interface StackEdges {
  bottom: string;
  top: string;
}

/** Геометрия сегмента, которую recharts передаёт в `shape`. */
interface SegmentGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: ChartRow;
}

/**
 * Прямоугольник со скруглением только сверху.
 *
 * Своя `path`, а не `radius` у `Bar`: `radius` скруглил бы каждый сегмент
 * стека, и столбец распался бы на плавающие таблетки. Скругляется только
 * свободный конец — у основания угол прямой, потому что там столбец стоит на
 * оси, а не заканчивается.
 */
function segmentPath(x: number, y: number, width: number, height: number, radius: number): string {
  if (radius <= 0) return `M${x},${y}h${width}v${height}h${-width}Z`;
  const r = Math.min(radius, width / 2, height);
  return [
    `M${x},${y + r}`,
    `a${r},${r} 0 0 1 ${r},${-r}`,
    `h${width - 2 * r}`,
    `a${r},${r} 0 0 1 ${r},${r}`,
    `v${height - r}`,
    `h${-width}`,
    'Z',
  ].join('');
}

function renderSegment(geometry: SegmentGeometry, seriesKey: string, edges: Map<string, StackEdges>): ReactElement {
  const { x = 0, y = 0, width = 0, height = 0, fill, payload } = geometry;
  if (!(width > 0) || !(height > 0)) return <g />;

  const bucketEdges = payload ? edges.get(payload.bucket) : undefined;
  // Зазор режется снизу сегмента, поэтому нижнему он не положен: иначе столбец
  // повис бы над осью.
  const gap = bucketEdges && bucketEdges.bottom === seriesKey ? 0 : STACK_GAP;
  const drawnHeight = height - gap >= MIN_SEGMENT_HEIGHT ? height - gap : height;
  const radius = bucketEdges && bucketEdges.top === seriesKey ? BAR_RADIUS : 0;

  return (
    <path
      d={segmentPath(x, y, width, drawnHeight, radius)}
      // Цвет через `style`, а не через атрибут `fill`: значение приходит как
      // `var(--chart-series-N)`, а в презентационном атрибуте `var()`
      // поддерживается неровно.
      style={{ fill }}
      // Неполный бакет рисуется полупрозрачным: календарно он выходит за
      // границы периода, и без пометки низкий столбец читается как провал,
      // хотя данные полные.
      fillOpacity={payload?.partial ? 0.45 : 1}
    />
  );
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

  // Ряды перечислены снизу вверх (порядок объявления `Bar`), а глазом столбец
  // читается сверху вниз — разворачиваем, чтобы список совпал с картинкой.
  const parts = (payload ?? []).filter((item) => Number(item.value ?? 0) !== 0).reverse();

  return (
    <div className="min-w-[200px] rounded-xl border border-zinc-200 bg-white px-3 py-2 shadow-lg">
      <div className="text-xs font-semibold text-zinc-900">{fullLabel(row.bucket, groupBy)}</div>
      <div className="mt-1.5 space-y-1">
        {parts.map((item) => (
          <div key={String(item.dataKey)} className="flex items-center gap-2">
            {/* Квадратик — подсказка, а не единственный ключ: рядом всегда стоит
                название ряда словом, иначе свёрнутая легенда стоила бы смысла. */}
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: item.color }}
              aria-hidden="true"
            />
            <span className="text-[11px] text-zinc-600">{labelOf(String(item.dataKey))}</span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-zinc-900">
              {formatRub(Number(item.value ?? 0))} ₽
            </span>
          </div>
        ))}
        {parts.length === 0 ? <div className="text-[11px] text-zinc-400">{zeroText}</div> : null}
      </div>
      <div className="mt-1.5 flex items-center gap-2 border-t border-zinc-100 pt-1.5">
        <span className="text-[11px] text-zinc-500">Итого</span>
        <span className="ml-auto font-mono text-[11px] font-semibold tabular-nums text-zinc-900">
          {formatRub(row.total)} ₽
        </span>
      </div>
      {row.partial ? (
        <p className="mt-1.5 max-w-[240px] border-t border-amber-200 pt-1.5 text-[11px] text-amber-700">
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
  // Легенда свёрнута по умолчанию — она справочник, а не постоянный элемент
  // чтения. Потерей информации это не становится: ряд назван словом в тултипе,
  // а числа целиком лежат в таблице под графиком.
  const [legendOpen, setLegendOpen] = useState(false);
  const legendId = useId();
  const reducedMotion = usePrefersReducedMotion();

  const { data, keys, edges, partialLabels } = useMemo(() => {
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

    const ordered = orderKeys(seen, canonicalOrder);

    // Края стека считаем один раз на перерисовку: `shape` вызывается для
    // каждого сегмента каждого столбца, и искать их там заново — лишняя работа
    // в горячем месте.
    const stackEdges = new Map<string, StackEdges>();
    for (const row of rows) {
      const present = ordered.filter((key) => Number(row[key] ?? 0) > 0);
      if (present.length === 0) continue;
      stackEdges.set(row.bucket, { bottom: present[0], top: present[present.length - 1] });
    }

    return {
      data: rows,
      keys: ordered,
      edges: stackEdges,
      partialLabels: rows.filter((row) => row.partial).map((row) => row.label),
    };
  }, [points, groupBy, canonicalOrder]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          {keys.length > 0 ? (
            <button
              type="button"
              onClick={() => setLegendOpen((prev) => !prev)}
              aria-expanded={legendOpen}
              aria-controls={legendId}
              className="flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
            >
              Легенда
              <svg
                width="9"
                height="9"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
                className={`transition-transform duration-150 ${legendOpen ? 'rotate-180' : ''}`}
              >
                <path
                  d="M2.5 4.5 6 8l3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {legendOpen ? (
        <div
          id={legendId}
          className="portal-disclosure mb-2 flex flex-wrap justify-end gap-x-4 gap-y-1.5 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2"
        >
          {keys.map((key) => (
            <span key={key} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ background: colorOf(key) }}
                aria-hidden="true"
              />
              <span className="text-[11px] text-zinc-600">{labelOf(key)}</span>
            </span>
          ))}
        </div>
      ) : null}

      {data.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-zinc-400">{emptyText}</div>
      ) : (
        <div style={{ height: 288 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }} barCategoryGap="24%">
              <CartesianGrid vertical={false} stroke={GRID_LINE} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                axisLine={{ stroke: AXIS_LINE }}
                tickLine={false}
                tickMargin={8}
              />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={60}
                tickMargin={6}
                tickFormatter={axisAmount}
              />
              <Tooltip
                // Подсветка идёт на всю категорию, а не на ширину столбца:
                // попадать мышью в узкую полоску не нужно, достаточно навести
                // на её вертикальную зону.
                cursor={{ fill: HOVER_BAND }}
                isAnimationActive={!reducedMotion}
                content={
                  <ChartTooltip
                    groupBy={groupBy}
                    labelOf={labelOf}
                    zeroText={zeroBucketText}
                    partialNote={partialTooltip}
                  />
                }
              />
              {keys.map((key) => (
                <Bar
                  key={key}
                  dataKey={key}
                  name={labelOf(key)}
                  stackId="a"
                  fill={colorOf(key)}
                  maxBarSize={MAX_BAR_WIDTH}
                  isAnimationActive={!reducedMotion}
                  animationDuration={320}
                  shape={(geometry: unknown) => renderSegment(geometry as SegmentGeometry, key, edges)}
                />
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
