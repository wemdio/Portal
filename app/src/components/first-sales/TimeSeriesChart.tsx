'use client';

import { useCallback, useMemo, useRef } from 'react';
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
  withAlpha,
  type ChartTheme,
} from '@/components/charts/theme';
import type { SeriesBucket } from '@/lib/firstSales/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

const LABELS: Record<'leads' | 'qualified' | 'meetings' | 'contracts', string> = {
  leads: 'Лиды',
  // Не просто «Квал»: qualified кладётся в корзину по дате ПРИХОДА лида
  // (когортно — «из пришедших в этот день скольких квалифицировали»), а
  // meetings/contracts ниже — по дате самого этапа. Без пояснения в легенде
  // все четыре числа читаются как «что случилось в этот день», и это неверно
  // для этого столбца.
  qualified: 'Квал (из пришедших)',
  meetings: 'Встречи',
  contracts: 'Договоры',
};

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Ключ корзины всегда YYYY-MM-DD (начало корзины в МСК, см. bucketKey в
// buckets.ts). Разбираем строку вручную, а не через `new Date(key)` — Date +
// toLocaleDateString подставили бы часовой пояс браузера и могли бы съехать
// на день в отрицательных смещениях от UTC.
function formatKey(key: string, groupBy: GroupBy): string {
  const [y, m, d] = key.split('-');
  if (!y || !m || !d) return key;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  return `${d}.${m}`;
}

interface TooltipItem {
  seriesName?: string;
  value?: number;
  dataIndex?: number;
  seriesIndex?: number;
}

/**
 * Столбцы для трёх верхних этапов и линия для договоров.
 *
 * Договоры вынесены в линию не ради разнообразия: их на порядок меньше лидов,
 * и четвёртый столбец в группе выродился бы в полоску в пару пикселей. Линия
 * поверх столбцов читается при любом соотношении величин. Все четыре ряда
 * при этом на ОДНОЙ шкале — второй оси справа здесь нет и быть не должно,
 * иначе «линия выше столбцов» переставало бы что-либо значить.
 */
/** Подсветка выбранной корзины: вертикальная полоса на всю высоту панели. */
function selectionMark(index: number) {
  return {
    silent: true,
    itemStyle: { color: HOVER_BAND },
    // Границы полуцелые: на категориальной оси число — это индекс категории,
    // и ±0.5 даёт ровно её полосу, от середины промежутка до середины следующего.
    data: [[{ xAxis: index - 0.5 }, { xAxis: index + 0.5 }]],
  };
}

function buildOption(
  data: SeriesBucket[],
  groupBy: GroupBy,
  theme: ChartTheme,
  animate: boolean,
  selectedIndex: number,
): EChartsCoreOption {
  const labels = data.map((b) => formatKey(b.key, groupBy));
  const keys = data.map((b) => b.key);

  const bar = (name: string, values: number[], slot: number) => ({
    name,
    type: 'bar' as const,
    data: values,
    barMaxWidth: 26,
    itemStyle: {
      color: verticalGradient(seriesColor(theme, slot)),
      borderRadius: [4, 4, 0, 0] as [number, number, number, number],
    },
    // Полоса выбора висит на первом ряду — рисовать её на каждом значило бы
    // класть одну и ту же заливку в четыре слоя.
    ...(slot === 0 && selectedIndex >= 0 ? { markArea: selectionMark(selectedIndex) } : {}),
  });

  const contractsColor = seriesColor(theme, 3);

  // Квадратики в подсказке красим по своему списку, а не по `params.color`.
  // У столбцов заливка — объект-градиент, и `params.color` возвращает именно
  // его; подставленный в CSS, он даёт `background:[object Object]`, то есть
  // пустоту. Строкой остаётся только линия, поэтому цвет был ровно у одного ряда.
  const swatches = [seriesColor(theme, 0), seriesColor(theme, 1), seriesColor(theme, 2), contractsColor];

  return {
    animation: animate,
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: CHART_FONT },
    grid: { left: 4, right: 8, top: 40, bottom: 4, containLabel: true },
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
          .map(
            (item) =>
              `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                 <span style="width:10px;height:10px;border-radius:3px;background:${
                   swatches[item.seriesIndex ?? 0] ?? 'transparent'
                 };flex:none"></span>
                 <span style="opacity:.75">${item.seriesName ?? ''}</span>
                 <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600">${item.value ?? 0}</span>
               </div>`,
          )
          .join('');
        return `<div style="font-weight:600">${keys[index] ?? ''}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: GRID_LINE } },
      axisLabel: { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT },
    },
    series: [
      bar(LABELS.leads, data.map((b) => b.leads), 0),
      bar(LABELS.qualified, data.map((b) => b.qualified), 1),
      bar(LABELS.meetings, data.map((b) => b.meetings), 2),
      {
        name: LABELS.contracts,
        type: 'line',
        data: data.map((b) => b.contracts),
        smooth: true,
        symbol: 'circle',
        symbolSize: 8,
        z: 3,
        lineStyle: { width: 3, color: contractsColor },
        itemStyle: { color: contractsColor, borderColor: theme.surface, borderWidth: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(contractsColor, 0.28) },
              { offset: 1, color: withAlpha(contractsColor, 0) },
            ],
          },
        },
      },
    ],
  };
}

export default function TimeSeriesChart({
  series,
  groupBy,
  selectedKey = null,
  onSelectKey,
}: {
  series: SeriesBucket[];
  groupBy: GroupBy;
  /** Выбранная корзина — подсвечивается полосой. */
  selectedKey?: string | null;
  /** Клик по корзине. Повторный клик по той же снимает выбор. */
  onSelectKey?: (key: string | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const selectedIndex = selectedKey ? series.findIndex((b) => b.key === selectedKey) : -1;

  const option = useMemo(
    () => (theme ? buildOption(series, groupBy, theme, !reducedMotion, selectedIndex) : null),
    [series, groupBy, theme, reducedMotion, selectedIndex],
  );

  const handleSelect = useCallback(
    (index: number) => {
      if (!onSelectKey) return;
      const bucket = series[index];
      if (!bucket) return;
      onSelectKey(bucket.key === selectedKey ? null : bucket.key);
    },
    [onSelectKey, series, selectedKey],
  );

  return (
    <div ref={rootRef} className="glass-tile p-3">
      {option ? (
        <EChart
          option={option}
          height={288}
          ariaLabel="Лиды, квалификация, встречи и договоры по периодам"
          onSelectIndex={onSelectKey ? handleSelect : undefined}
          className={onSelectKey ? 'cursor-pointer' : undefined}
        />
      ) : (
        <div style={{ height: 288 }} />
      )}
      <p className="mt-2 text-[11px] text-zinc-400">
        «Квал (из пришедших)» — когорта: из лидов, пришедших в эту корзину, сколько в итоге дошли до квалификации
        (независимо от даты самого перехода). «Встречи» и «Договоры» — по дате самого события, а не даты прихода лида.
        Две разные логики соседствуют на одном графике намеренно, но читать их как «что случилось в этот день» для всех
        четырёх рядов сразу — ошибка.
      </p>
      <p className="mt-1 text-[11px] text-amber-700">
        Встречи считаются по датам записей разговоров в чате встреч, а не по этапу AMO «Встреча проведена» — этот этап
        был засорён и показывал 200+ встреч в месяц против 64 реальных. Подписи к записям стали регулярными с
        01.05.2026 — за более ранние периоды линия встреч пустая: это отказ считать недостоверное, а не отсутствие встреч.
      </p>
      <p className="mt-1 text-[11px] text-amber-700">
        Договоры считаются с 30.07.2026 — с этой даты этап «Согласование договора» в AMO ставится только при реальном
        согласовании и правках. Раньше туда попадали и сделки, которым договор просто отправили, поэтому за прошлые
        периоды линия договоров пустая: это отказ считать недостоверное, а не отсутствие договоров.
      </p>
    </div>
  );
}
