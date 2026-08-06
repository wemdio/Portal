'use client';

import { useMemo, useRef } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import EChart from '@/components/charts/EChart';
import {
  AXIS_FONT_SIZE,
  AXIS_LINE,
  AXIS_TEXT,
  CHART_FONT,
  GRID_LINE,
  HOVER_BAND,
  LEGEND_FONT_SIZE,
  seriesColor,
  tooltipSkin,
  useChartTheme,
  usePrefersReducedMotion,
  verticalGradient,
  type ChartTheme,
} from '@/components/charts/theme';
import { formatRub } from '@/lib/expenses/client';
import type { GroupBy } from '@/lib/expenses/period';

/**
 * Доход и расход рядом, под ними — разница.
 *
 * Обе панели в рублях и на разных шкалах: доход с расходом меряются десятками
 * тысяч, а разница может быть около нуля, и на общей шкале она превратилась бы
 * в прямую линию по оси. Это НЕ вторая ось на одном графике — там нельзя
 * сравнивать высоты между рядами, потому что масштаб выбран произвольно. Здесь
 * панели разделены, у каждой своя подпись, и сравниваются формы, а не высоты.
 *
 * Разница красится теми же двумя цветами, что и столбцы сверху: плюс — цветом
 * дохода, минус — цветом расхода. Значение подхватывается без легенды, потому
 * что цвет уже объяснён строкой выше.
 */

export interface ProfitPoint {
  bucket: string;
  income: number;
  expense: number;
  /** Календарные границы бакета выходят за период — столбец ниже соседних. */
  partial: boolean;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Поля панелей — числами и одинаковые у обеих: иначе один и тот же период
 *  встанет на разной вертикали сверху и снизу. Слева заложено под «1,5 млн». */
const GRID_LEFT = 68;
const GRID_RIGHT = 16;

function splitKey(key: string): [string, string, string] | null {
  const [y, m, d] = key.split('-');
  if (!y || !m || !d) return null;
  return [y, m, d];
}

function axisLabel(key: string, groupBy: GroupBy): string {
  const parts = splitKey(key);
  if (!parts) return key;
  const [y, m, d] = parts;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  return `${d}.${m}`;
}

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

function axisAmount(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1_000_000) {
    const millions = (abs / 1_000_000).toFixed(1).replace(/[.,]0$/, '').replace('.', ',');
    return `${sign}${millions} млн`;
  }
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)} тыс`;
  return `${sign}${formatRub(abs)}`;
}

interface TooltipItem {
  dataIndex?: number;
}

function buildOption(
  points: ProfitPoint[],
  groupBy: GroupBy,
  theme: ChartTheme,
  animate: boolean,
): EChartsCoreOption {
  const incomeColor = seriesColor(theme, 2);
  const expenseColor = seriesColor(theme, 1);
  const labels = points.map((p) => axisLabel(p.bucket, groupBy));
  const axis = { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT };

  const bar = (values: number[], color: string) =>
    points.map((point, i) => ({
      value: values[i],
      itemStyle: {
        color: verticalGradient(color),
        // Неполный бакет полупрозрачный: он ниже соседних не потому, что денег
        // стало меньше, а потому что в него попало меньше дней.
        opacity: point.partial ? 0.45 : 1,
      },
    }));

  return {
    animation: animate,
    animationDuration: 500,
    textStyle: { fontFamily: CHART_FONT },
    grid: [
      { left: GRID_LEFT, right: GRID_RIGHT, top: 32, height: 150 },
      { left: GRID_LEFT, right: GRID_RIGHT, top: 224, height: 84 },
    ],
    legend: {
      top: 0,
      left: 0,
      itemGap: 16,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: AXIS_TEXT, fontSize: LEGEND_FONT_SIZE, fontFamily: CHART_FONT },
      data: ['Доход', 'Расход'],
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: HOVER_BAND } },
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as TooltipItem[];
        const point = points[items[0]?.dataIndex ?? 0];
        if (!point) return '';
        const profit = point.income - point.expense;
        const row = (name: string, value: number, color: string) =>
          `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
             <span style="width:10px;height:10px;border-radius:3px;background:${color};flex:none"></span>
             <span style="opacity:.75">${name}</span>
             <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600">${formatRub(
               value,
             )} ₽</span>
           </div>`;
        return (
          `<div style="font-weight:600">${fullLabel(point.bucket, groupBy)}</div>` +
          row('Доход', point.income, incomeColor) +
          row('Расход', point.expense, expenseColor) +
          `<div style="display:flex;gap:8px;margin-top:8px;padding-top:6px;border-top:1px solid ${GRID_LINE}">
             <span style="opacity:.6">${profit < 0 ? 'Убыток' : 'Прибыль'}</span>
             <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700">${formatRub(
               profit,
             )} ₽</span>
           </div>`
        );
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: labels,
        axisLine: { lineStyle: { color: AXIS_LINE } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: labels,
        axisLine: { lineStyle: { color: AXIS_LINE } },
        axisTick: { show: false },
        axisLabel: axis,
      },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        splitLine: { lineStyle: { color: GRID_LINE } },
        axisLabel: { ...axis, formatter: (value: number) => axisAmount(value) },
      },
      {
        type: 'value',
        gridIndex: 1,
        splitLine: { lineStyle: { color: GRID_LINE } },
        axisLabel: { ...axis, formatter: (value: number) => axisAmount(value) },
      },
    ],
    series: [
      {
        name: 'Доход',
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        barMaxWidth: 26,
        data: bar(points.map((p) => p.income), incomeColor),
        itemStyle: { borderRadius: [4, 4, 0, 0] as [number, number, number, number] },
      },
      {
        name: 'Расход',
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        barMaxWidth: 26,
        data: bar(points.map((p) => p.expense), expenseColor),
        itemStyle: { borderRadius: [4, 4, 0, 0] as [number, number, number, number] },
      },
      {
        name: 'Разница',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 26,
        // В легенду не выносим: цвета уже объяснены рядами выше, а третий
        // пункт «Разница» с двумя цветами сразу только запутал бы.
        data: points.map((point) => {
          const profit = point.income - point.expense;
          const color = profit < 0 ? expenseColor : incomeColor;
          return {
            value: profit,
            itemStyle: {
              color: verticalGradient(color),
              opacity: point.partial ? 0.45 : 1,
              // Столбец убытка растёт вниз, поэтому скругляем нижний конец.
              borderRadius: (profit < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0]) as [number, number, number, number],
            },
          };
        }),
      },
    ],
  };
}

export default function ProfitChart({ points, groupBy }: { points: ProfitPoint[]; groupBy: GroupBy }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const option = useMemo(
    () => (theme ? buildOption(points, groupBy, theme, !reducedMotion) : null),
    [points, groupBy, theme, reducedMotion],
  );

  return (
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">Доход и расход по времени</h3>
      {points.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-zinc-400">За выбранный период движения нет.</div>
      ) : option ? (
        <EChart option={option} height={340} ariaLabel="Доход, расход и разница по периодам" />
      ) : (
        <div style={{ height: 340 }} />
      )}
    </div>
  );
}
