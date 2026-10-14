'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import EChart from '@/components/charts/EChart';
import SeriesPicker from '@/components/charts/SeriesPicker';
import {
  AXIS_FONT_SIZE,
  AXIS_LINE,
  AXIS_TEXT,
  CHART_FONT,
  GRID_LINE,
  HOVER_BAND,
  seriesColor,
  tooltipSkin,
  useChartTheme,
  usePrefersReducedMotion,
  withAlpha,
  type ChartTheme,
} from '@/components/charts/theme';
import type { RenewalSeriesBucket } from '@/lib/renewals/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

type MetricKey = 'count' | 'revenue';

const LABELS: Record<MetricKey, string> = {
  count: 'Продлений',
  revenue: 'Оборот, ₽',
};

const METRICS: MetricKey[] = ['count', 'revenue'];

/**
 * Поля панелей заданы числами, а не `containLabel`, и обязаны совпадать у обеих:
 * от этого зависит, что один и тот же период стоит на одной вертикали сверху и
 * снизу. Слева заложено под самую широкую денежную подпись вида «1,5 млн».
 */
const GRID_LEFT = 68;
const GRID_RIGHT = 16;

/** Высота холста (просьба 09.10.2026 — «повыше»). Делится между панелями. */
const CHART_HEIGHT = 440;
/** Отступы внутри холста: сверху — воздух, снизу — подписи периодов. */
const PAD_TOP = 12;
const PAD_BOTTOM = 34;
/** Зазор между панелями, когда их две. */
const PANEL_GAP = 46;

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
  dataIndex?: number;
  seriesIndex?: number;
}

/**
 * Количество продлений и оборот — двумя графиками друг под другом, с общей
 * осью периодов. Оставлен один показатель — панель у него одна, во всю высоту.
 *
 * Раньше это был один график с двумя осями Y: продления слева, рубли справа.
 * Так делать нельзя — взаимное положение двух рядов на таком графике не значит
 * ничего, потому что задаётся выбором масштаба, а не данными. Достаточно
 * подобрать вторую шкалу, чтобы «оборот обгоняет продления» превратилось в
 * «отстаёт». Две отдельные панели с общей осью X показывают ровно ту же связь,
 * но ни к чему не подталкивают: сравниваются формы, а не высоты.
 */
/** Подсветка выбранной корзины: вертикальная полоса на всю высоту панели. */
function selectionMark(index: number) {
  return {
    silent: true,
    itemStyle: { color: HOVER_BAND },
    // Границы полуцелые: на категориальной оси число — это индекс категории,
    // и ±0.5 даёт ровно её полосу, от середины промежутка до середины следующей.
    data: [[{ xAxis: index - 0.5 }, { xAxis: index + 0.5 }]],
  };
}

function buildOption(
  data: RenewalSeriesBucket[],
  groupBy: GroupBy,
  theme: ChartTheme,
  animate: boolean,
  selectedIndex: number,
  visible: ReadonlySet<MetricKey>,
): EChartsCoreOption {
  const labels = data.map((b) => formatKey(b.key, groupBy));
  const keys = data.map((b) => b.key);
  const colorOf = (key: MetricKey) => seriesColor(theme, key === 'count' ? 0 : 2);

  const shown = METRICS.filter((key) => visible.has(key));
  // Квадратики в подсказке — по своему списку: подписи рядов совпадают с
  // порядком видимых панелей, и брать цвет из params нельзя (у заливки это
  // объект-градиент, а не строка).
  const swatches = shown.map(colorOf);

  // Панели: одна на показатель. Подписи периодов стоят один раз — под нижней.
  //
  // Отступ слева задан числом и ОДИНАКОВЫЙ у обеих панелей. С `containLabel`
  // каждая панель считала бы его сама по ширине своих подписей — а они разные
  // («7» против «1,5 млн»), — и области построения разъезжались бы по
  // горизонтали на пару десятков пикселей. Тогда один и тот же день оказывался
  // бы в разных местах верхней и нижней панели, что и ломало чтение.
  const panelHeight = shown.length === 2
    ? (CHART_HEIGHT - PAD_TOP - PAD_BOTTOM - PANEL_GAP) / 2
    : CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const grid = shown.map((_, index) => ({
    left: GRID_LEFT,
    right: GRID_RIGHT,
    top: PAD_TOP + index * (panelHeight + PANEL_GAP),
    height: panelHeight,
  }));

  const axisLabel = { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT };

  return {
    animation: animate,
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: CHART_FONT },
    grid,
    // Легенды нет: ряды включаются переключателями над графиком (SeriesPicker).
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: GRID_LINE } },
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as TooltipItem[];
        const index = items[0]?.dataIndex ?? 0;
        const rows = items
          .map((item) => {
            const isMoney = item.seriesName === LABELS.revenue;
            const value = Number(item.value ?? 0);
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                      <span style="width:10px;height:10px;border-radius:3px;background:${
                        swatches[item.seriesIndex ?? 0] ?? 'transparent'
                      };flex:none"></span>
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
    xAxis: shown.map((_, index) => ({
      type: 'category' as const,
      gridIndex: index,
      // boundaryGap=false — линия начинается у самой оси: у линейного ряда
      // отступы по краям оставляют пустые поля, которых нечем заполнить.
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      // Подписи периодов — только под нижней панелью.
      axisLabel: index === shown.length - 1 ? axisLabel : { show: false },
    })),
    yAxis: shown.map((key, index) => ({
      type: 'value' as const,
      gridIndex: index,
      ...(key === 'count' ? { minInterval: 1 } : {}),
      splitLine: { lineStyle: { color: GRID_LINE } },
      axisLabel: key === 'revenue'
        ? { ...axisLabel, formatter: (value: number) => axisAmount(value) }
        : axisLabel,
    })),
    series: shown.map((key, index) => {
      const color = colorOf(key);
      return {
        name: LABELS[key],
        type: 'line' as const,
        xAxisIndex: index,
        yAxisIndex: index,
        data: data.map((b) => b[key]),
        // Ломаная, а не сплайн: сглаживание между помесячными суммами рисует
        // значения, которых не существует, и вдобавок выгибается выше
        // фактического максимума. Продление — событие дискретное. Точки
        // показываем: при 32 продлениях за всю историю месяцев с данными мало,
        // и без них ломаная читается как непрерывный процесс.
        smooth: false,
        symbol: 'circle',
        showSymbol: data.length <= 40,
        symbolSize: 7,
        lineStyle: { width: 2.5, color },
        itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(color, 0.26) },
              { offset: 1, color: withAlpha(color, 0) },
            ],
          },
        },
        ...(selectedIndex >= 0 ? { markArea: selectionMark(selectedIndex) } : {}),
      };
    }),
  };
}

/**
 * Помесячный (или по дню/неделе — по выбору) график продлений. Вторичен по
 * отношению к таблице ниже него на странице: продлений всего 32 за всю
 * историю, и график из двух-трёх точек менее полезен, чем список, где видно
 * каждое продление (см. план дашборда). Оставлен для быстрого взгляда на
 * динамику, а не как основной инструмент анализа.
 */
export default function RenewalsChart({
  series,
  groupBy,
  selectedKey = null,
  onSelectKey,
}: {
  series: RenewalSeriesBucket[];
  groupBy: GroupBy;
  /** Выбранная корзина — подсвечивается полосой. */
  selectedKey?: string | null;
  /** Клик по корзине. Повторный клик по той же снимает выбор. */
  onSelectKey?: (key: string | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();
  const [visible, setVisible] = useState<ReadonlySet<MetricKey>>(() => new Set(METRICS));

  const selectedIndex = selectedKey ? series.findIndex((b) => b.key === selectedKey) : -1;

  const option = useMemo(
    () => (theme ? buildOption(series, groupBy, theme, !reducedMotion, selectedIndex, visible) : null),
    [series, groupBy, theme, reducedMotion, selectedIndex, visible],
  );

  const toggle = useCallback((key: MetricKey) => {
    setVisible((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (index: number) => {
      if (!onSelectKey) return;
      const bucket = series[index];
      if (!bucket) return;
      onSelectKey(bucket.key === selectedKey ? null : bucket.key);
    },
    [onSelectKey, series, selectedKey],
  );

  const pickerItems = useMemo(
    () => METRICS.map((key) => ({
      key,
      label: LABELS[key],
      color: theme ? seriesColor(theme, key === 'count' ? 0 : 2) : 'transparent',
    })),
    [theme],
  );

  return (
    <div ref={rootRef} className="glass-tile p-3">
      <SeriesPicker items={pickerItems} visible={visible} onToggle={toggle} className="mb-2" />
      {option ? (
        <EChart
          option={option}
          height={CHART_HEIGHT}
          ariaLabel="Количество продлений и оборот по периодам"
          onSelectIndex={onSelectKey ? handleSelect : undefined}
          className={onSelectKey ? 'cursor-pointer' : undefined}
        />
      ) : (
        <div style={{ height: CHART_HEIGHT }} />
      )}
    </div>
  );
}
