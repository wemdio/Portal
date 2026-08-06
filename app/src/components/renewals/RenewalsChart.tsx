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
import type { RenewalSeriesBucket } from '@/lib/renewals/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Поля панелей заданы числами, а не `containLabel`, и обязаны совпадать у обеих:
 * от этого зависит, что один и тот же период стоит на одной вертикали сверху и
 * снизу. Слева заложено под самую широкую денежную подпись вида «1,5 млн».
 */
const GRID_LEFT = 68;
const GRID_RIGHT = 16;

// Ключ корзины всегда YYYY-MM-DD (начало корзины в МСК, см. bucketKey в
// buckets.ts). Разбираем строку вручную, а не через `new Date(key)` — Date +
// toLocaleDateString подставили бы часовой пояс браузера и могли бы съехать
// на день в отрицательных смещениях от UTC. Тот же приём, что в
// first-sales/TimeSeriesChart.tsx.
function formatKey(key: string, groupBy: GroupBy): string {
  const [y, m, d] = key.split('-');
  if (!y || !m || !d) return key;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  return `${d}.${m}`;
}

function formatRub(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** Подпись деления денежной оси: порядок величины читается быстрее полной суммы. */
function axisAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(1).replace(/[.,]0$/, '').replace('.', ',');
    return `${millions} млн`;
  }
  if (abs >= 10_000) return `${Math.round(value / 1000)} тыс`;
  return formatRub(value);
}

interface TooltipItem {
  seriesName?: string;
  value?: number;
  color?: string;
  dataIndex?: number;
}

/**
 * Количество продлений и оборот — двумя графиками друг под другом, с общей
 * осью периодов.
 *
 * Раньше это был один график с двумя осями Y: продления слева, рубли справа.
 * Так делать нельзя — взаимное положение столбца и линии на таком графике не
 * значит ничего, потому что задаётся выбором масштаба, а не данными. Достаточно
 * подобрать вторую шкалу, чтобы «оборот обгоняет продления» превратилось в
 * «отстаёт». Две отдельные панели с общей осью X показывают ровно ту же связь,
 * но ни к чему не подталкивают: сравниваются формы, а не высоты.
 */
function buildOption(
  data: RenewalSeriesBucket[],
  groupBy: GroupBy,
  theme: ChartTheme,
  animate: boolean,
): EChartsCoreOption {
  const labels = data.map((b) => formatKey(b.key, groupBy));
  const keys = data.map((b) => b.key);
  const countColor = seriesColor(theme, 0);
  const revenueColor = seriesColor(theme, 2);

  const axisLabel = { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT };

  return {
    animation: animate,
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: CHART_FONT },
    // Две панели: верхняя под количество, нижняя под деньги. Подписи периодов
    // стоят один раз — под нижней.
    //
    // Отступ слева задан числом и ОДИНАКОВЫЙ у обеих панелей. С `containLabel`
    // каждая панель считала бы его сама по ширине своих подписей — а они
    // разные («7» против «1,5 млн»), — и области построения разъезжались бы по
    // горизонтали на пару десятков пикселей. Тогда один и тот же день оказывался
    // бы в разных местах верхней и нижней панели, что и ломало чтение.
    grid: [
      { left: GRID_LEFT, right: GRID_RIGHT, top: 30, height: 122 },
      { left: GRID_LEFT, right: GRID_RIGHT, top: 190, height: 96 },
    ],
    legend: {
      top: 0,
      left: 0,
      itemGap: 16,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: AXIS_TEXT, fontSize: LEGEND_FONT_SIZE, fontFamily: CHART_FONT },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: HOVER_BAND } },
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as TooltipItem[];
        const index = items[0]?.dataIndex ?? 0;
        const rows = items
          .map((item) => {
            const isMoney = item.seriesName === 'Оборот, ₽';
            const value = Number(item.value ?? 0);
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                      <span style="width:10px;height:10px;border-radius:3px;background:${item.color};flex:none"></span>
                      <span style="opacity:.75">${item.seriesName ?? ''}</span>
                      <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600">${
                        isMoney ? `${formatRub(value)} ₽` : value
                      }</span>
                    </div>`;
          })
          .join('');
        return `<div style="font-weight:600">${keys[index] ?? ''}</div>${rows}`;
      },
    },
    // Наведение на любую из панелей подсвечивает обе — иначе связь между
    // количеством и деньгами пришлось бы искать глазами.
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
        axisLabel,
      },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        minInterval: 1,
        splitLine: { lineStyle: { color: GRID_LINE } },
        axisLabel,
      },
      {
        type: 'value',
        gridIndex: 1,
        splitLine: { lineStyle: { color: GRID_LINE } },
        axisLabel: { ...axisLabel, formatter: (value: number) => axisAmount(value) },
      },
    ],
    series: [
      {
        name: 'Продлений',
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((b) => b.count),
        barMaxWidth: 26,
        itemStyle: {
          color: verticalGradient(countColor),
          borderRadius: [4, 4, 0, 0] as [number, number, number, number],
        },
      },
      {
        name: 'Оборот, ₽',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((b) => b.revenue),
        // Ломаная, а не сплайн: сглаживание между помесячными суммами рисует
        // значения, которых не существует, и вдобавок выгибается выше
        // фактического максимума. Продление — событие дискретное. Точки
        // показываем: при 32 продлениях за всю историю месяцев с данными мало,
        // и без них ломаная читается как непрерывный процесс.
        smooth: false,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2.5, color: revenueColor },
        itemStyle: { color: revenueColor, borderColor: theme.surface, borderWidth: 2 },
      },
    ],
  };
}

/**
 * Помесячный (или по дню/неделе — по выбору) график продлений. Вторичен по
 * отношению к таблице ниже него на странице: продлений всего 32 за всю
 * историю, и график из двух-трёх столбиков менее полезен, чем список, где
 * видно каждое продление (см. план дашборда). Оставлен для быстрого взгляда
 * на динамику, а не как основной инструмент анализа.
 */
export default function RenewalsChart({ series, groupBy }: { series: RenewalSeriesBucket[]; groupBy: GroupBy }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const option = useMemo(
    () => (theme ? buildOption(series, groupBy, theme, !reducedMotion) : null),
    [series, groupBy, theme, reducedMotion],
  );

  return (
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
      {option ? (
        <EChart option={option} height={330} ariaLabel="Количество продлений и оборот по периодам" />
      ) : (
        <div style={{ height: 330 }} />
      )}
    </div>
  );
}
