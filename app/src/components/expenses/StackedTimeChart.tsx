'use client';

import { useMemo, useRef, type ReactNode } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import EChart from '@/components/charts/EChart';
import {
  AXIS_FONT_SIZE,
  AXIS_LINE,
  AXIS_TEXT,
  CHART_FONT,
  GRID_LINE,
  HOVER_BAND,
  tooltipSkin,
  useChartTheme,
  usePrefersReducedMotion,
  verticalGradient,
  type ChartTheme,
} from '@/components/charts/theme';
import { formatRub, formatShare } from '@/lib/expenses/client';
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
 * Оформление собрано вручную, а не оставлено на дефолты: столбцы со
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

/** Столбец не должен разъезжаться в плиту, когда бакетов в периоде два-три. */
const MAX_BAR_WIDTH = 44;

/** Непрозрачность неполного бакета — он не «провал», а незаконченный отрезок. */
const PARTIAL_OPACITY = 0.45;

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

/** Порядок рядов фиксирован, чтобы цвета не прыгали между перерисовками. */
function orderKeys(keys: Set<string>, canonical: readonly string[]): string[] {
  const known = canonical.filter((key) => keys.has(key));
  const unknown = [...keys].filter((key) => !canonical.includes(key)).sort();
  return [...known, ...unknown];
}

interface TooltipItem {
  seriesName?: string;
  value?: number;
  dataIndex?: number;
  seriesIndex?: number;
}

function buildOption({
  points,
  keys,
  groupBy,
  labelOf,
  colorAt,
  theme,
  animate,
  zeroBucketText,
  partialTooltip,
}: {
  points: StackedPoint[];
  keys: string[];
  groupBy: GroupBy;
  labelOf: (key: string) => string;
  colorAt: (key: string) => string;
  theme: ChartTheme;
  animate: boolean;
  zeroBucketText: string;
  partialTooltip: string;
}): EChartsCoreOption {
  // Верхний непустой сегмент каждого столбца считаем один раз: скругляется
  // только свободный конец стека, у основания и в середине угол прямой, иначе
  // столбец распался бы на плавающие таблетки.
  const topKeyByBucket = new Map<string, string>();
  for (const point of points) {
    const present = keys.filter((key) => Number(point.parts[key] ?? 0) > 0);
    if (present.length > 0) topKeyByBucket.set(point.bucket, present[present.length - 1]);
  }

  // Квадратики в подсказке — по своему списку, а не по `params.color`: заливка
  // сегмента объект-градиент, и в CSS он превратился бы в `[object Object]`,
  // то есть в пустое место вместо цвета.
  const swatches = keys.map(colorAt);

  return {
    animation: animate,
    animationDuration: 320,
    textStyle: { fontFamily: CHART_FONT },
    grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      // Подсветка идёт на всю категорию, а не на ширину столбца: попадать мышью
      // в узкую полоску не нужно, достаточно навести на её вертикальную зону.
      axisPointer: { type: 'shadow', shadowStyle: { color: HOVER_BAND } },
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as TooltipItem[];
        const index = items[0]?.dataIndex ?? 0;
        const point = points[index];
        if (!point) return '';

        // Ряды перечислены снизу вверх (порядок объявления серий), а глазом
        // столбец читается сверху вниз — разворачиваем, чтобы список совпал
        // с картинкой.
        const rows = items
          .filter((item) => Number(item.value ?? 0) !== 0)
          .reverse()
          .map(
            (item) =>
              `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                 <span style="width:10px;height:10px;border-radius:3px;background:${
                   swatches[item.seriesIndex ?? 0] ?? 'transparent'
                 };flex:none"></span>
                 <span style="opacity:.75">${item.seriesName ?? ''}</span>
                 <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600">${formatRub(
                   Number(item.value ?? 0),
                 )} ₽</span>
               </div>`,
          )
          .join('');

        const empty = rows ? '' : `<div style="margin-top:4px;opacity:.6">${zeroBucketText}</div>`;
        const total = `<div style="display:flex;gap:8px;margin-top:8px;padding-top:6px;border-top:1px solid ${GRID_LINE}">
                         <span style="opacity:.6">Итого</span>
                         <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700">${formatRub(
                           point.total,
                         )} ₽</span>
                       </div>`;
        const partial = point.partial
          ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${GRID_LINE};max-width:240px;white-space:normal;color:#b45309">${partialTooltip}</div>`
          : '';

        return `<div style="font-weight:600">${fullLabel(point.bucket, groupBy)}</div>${rows}${empty}${total}${partial}`;
      },
    },
    xAxis: {
      type: 'category',
      data: points.map((point) => axisLabel(point.bucket, groupBy)),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT, margin: 10 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: GRID_LINE } },
      axisLabel: {
        color: AXIS_TEXT,
        fontSize: AXIS_FONT_SIZE,
        fontFamily: CHART_FONT,
        formatter: (value: number) => axisAmount(value),
      },
    },
    series: keys.map((key) => ({
      name: labelOf(key),
      type: 'bar' as const,
      stack: 'total',
      barMaxWidth: MAX_BAR_WIDTH,
      barCategoryGap: '24%',
      itemStyle: {
        // Градиент внутри сегмента мягкий (до 0.78, а не до 0.4 как у одиночных
        // столбцов): у стека соседние сегменты стоят вплотную, и сильная
        // растяжка по светлоте начала бы спорить с границей между рядами.
        color: verticalGradient(colorAt(key), 0.78),
        // Зазора между сегментами стека в echarts нет, поэтому рисуем рамку
        // цветом карточки: у двух соседних сегментов она складывается в
        // двухпиксельный просвет, и стек читается как набор частей.
        borderColor: theme.surface,
        borderWidth: 1,
      },
      data: points.map((point) => ({
        value: point.parts[key] ?? 0,
        itemStyle: {
          borderRadius:
            topKeyByBucket.get(point.bucket) === key
              ? ([BAR_RADIUS, BAR_RADIUS, 0, 0] as [number, number, number, number])
              : ([0, 0, 0, 0] as [number, number, number, number]),
          // Неполный бакет рисуется полупрозрачным: календарно он выходит за
          // границы периода, и без пометки низкий столбец читается как провал,
          // хотя данные полные.
          opacity: point.partial ? PARTIAL_OPACITY : 1,
        },
      })),
    })),
  };
}

/**
 * Кольцо долей за весь период — рядом со столбцами по времени.
 *
 * Столбцы отвечают на вопрос «как менялось», кольцо — «из чего состоит». По
 * стеку долю на глаз не взять: сегменты стоят на разной высоте и сравнивать
 * их приходится длинами отрезков, а не углами.
 *
 * Подписи на самих секторах не рисуются: при десятке разрезов они наезжают
 * друг на друга. Расшифровка — в легенде под кольцом, она и так всегда видна.
 */
function buildDonutOption({
  totals,
  labelOf,
  colorAt,
  theme,
  animate,
  grandTotal,
}: {
  totals: { key: string; value: number }[];
  labelOf: (key: string) => string;
  colorAt: (key: string) => string;
  theme: ChartTheme;
  animate: boolean;
  grandTotal: number;
}): EChartsCoreOption {
  return {
    animation: animate,
    animationDuration: 320,
    textStyle: { fontFamily: CHART_FONT },
    tooltip: {
      trigger: 'item',
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const item = params as { name?: string; value?: number };
        const value = Number(item.value ?? 0);
        const share = grandTotal > 0 ? formatShare(value / grandTotal) : '—';
        return `<div style="font-weight:600">${item.name ?? ''}</div>
                <div style="margin-top:4px;font-variant-numeric:tabular-nums">${formatRub(value)} ₽ · ${share}</div>`;
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
        data: totals.map((entry) => ({
          name: labelOf(entry.key),
          value: entry.value,
          itemStyle: { color: colorAt(entry.key) },
        })),
      },
    ],
  };
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
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const { keys, partialLabels, seriesTotals, grandTotal } = useMemo(() => {
    const seen = new Set<string>();
    const sums = new Map<string, number>();
    for (const point of points) {
      for (const [key, value] of Object.entries(point.parts)) {
        seen.add(key);
        sums.set(key, (sums.get(key) ?? 0) + Number(value ?? 0));
      }
    }
    const ordered = orderKeys(seen, canonicalOrder);
    // Нули в кольцо не кладём: сектор нулевой ширины не рисуется, но забирает
    // себе место в подсказках и делает обводку рваной.
    const totals = ordered
      .map((key) => ({ key, value: sums.get(key) ?? 0 }))
      .filter((entry) => entry.value > 0);

    return {
      keys: ordered,
      partialLabels: points.filter((p) => p.partial).map((p) => axisLabel(p.bucket, groupBy)),
      seriesTotals: totals,
      grandTotal: totals.reduce((acc, entry) => acc + entry.value, 0),
    };
  }, [points, groupBy, canonicalOrder]);

  const option = useMemo(() => {
    if (!theme || points.length === 0) return null;
    // `theme.resolveColor` привязан к элементу, от которого тема прочитана, —
    // так `var(--chart-series-N)` разворачивается без обращения к ref во время
    // рендера, а `theme` в зависимостях даёт пересчёт при переключении темы.
    const colorAt = (key: string) => theme.resolveColor(colorOf(key));
    return buildOption({
      points,
      keys,
      groupBy,
      labelOf,
      colorAt,
      theme,
      animate: !reducedMotion,
      zeroBucketText,
      partialTooltip,
    });
  }, [points, keys, groupBy, labelOf, colorOf, theme, reducedMotion, zeroBucketText, partialTooltip]);

  const donutOption = useMemo(() => {
    if (!theme || seriesTotals.length === 0) return null;
    return buildDonutOption({
      totals: seriesTotals,
      labelOf,
      colorAt: (key: string) => theme.resolveColor(colorOf(key)),
      theme,
      animate: !reducedMotion,
      grandTotal,
    });
  }, [seriesTotals, grandTotal, labelOf, colorOf, theme, reducedMotion]);

  return (
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
      </div>

      {points.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-zinc-400">{emptyText}</div>
      ) : (
        // Легенда — вертикальным блоком СПРАВА от графика, а не полосой над
        // ним: горизонтальная полоса отъедала высоту у столбцов и при большом числе
        // разрезов переносилась на вторую строку, каждый раз сдвигая график
        // по вертикали. Сбоку она растёт вниз, не трогая ни высоту, ни
        // положение столбцов.
        //
        // На узком экране (`flex-col`) блок возвращается под график: колонка
        // легенды съела бы там половину ширины, а график важнее справочника.
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <div className="min-w-0 flex-1">
            {option ? (
              <EChart option={option} height={288} ariaLabel={title} />
            ) : (
              <div style={{ height: 288 }} />
            )}
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:w-[210px]">
            {/* Кольцо отвечает на «из чего состоит», столбцы слева — на «как
                менялось». Долю по стеку на глаз не взять: сегменты стоят на
                разной высоте, и сравнивать пришлось бы длины отрезков. */}
            {donutOption ? <EChart option={donutOption} height={150} ariaLabel={`${title}: доли за период`} /> : null}

            {/* Легенда видна всегда — без кнопки и без сворачивания. Прятать
                расшифровку цветов за кликом значит требовать этот клик каждый
                раз: цвет сегмента сам по себе ничего не говорит, а тултип
                появляется только при наведении на конкретный столбец. */}
            {keys.length > 0 ? (
              <div className="flex flex-row flex-wrap gap-x-4 gap-y-1.5 self-start rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2 sm:w-full sm:flex-col sm:flex-nowrap">
                {keys.map((key) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                      style={{ background: colorOf(key) }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-[11px] text-zinc-600" title={labelOf(key)}>
                      {labelOf(key)}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
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
