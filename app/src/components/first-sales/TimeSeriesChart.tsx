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
import type { SeriesBucket } from '@/lib/firstSales/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

type MetricKey = 'leads' | 'qualified' | 'meetings' | 'sales';

const LABELS: Record<MetricKey, string> = {
  leads: 'Лиды',
  // Не просто «Квал»: qualified кладётся в корзину по дате ПРИХОДА лида
  // (когортно — «из пришедших в этот день скольких квалифицировали»), а
  // meetings/sales ниже — по дате самого события. Без пояснения в легенде
  // все четыре числа читаются как «что случилось в этот день», и это неверно
  // для этого столбца.
  qualified: 'Квал (из пришедших)',
  meetings: 'Встречи',
  sales: 'Продажи',
};

/** Порядок рядов = порядок слотов палитры: ряд всегда своего цвета, даже погашенный. */
const METRICS: MetricKey[] = ['leads', 'qualified', 'meetings', 'sales'];

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Высота холста. Просьба продаж 09.10.2026: на 288 дневной ряд за полгода
 *  сплющивался в полосу, в которой не читались ни пики, ни провалы. */
const CHART_HEIGHT = 420;

// Ключ корзины всегда YYYY-MM-DD (начало корзины в МСК, см. bucketKey в
// buckets.ts). Разбираем строку вручную, а не через `new Date(key)`: Date +
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

/**
 * Сплошные линии с заливкой — все четыре этапа на одной шкале.
 *
 * Раньше три этапа рисовались столбцами, а договоры линией поверх них. При
 * дневной раскладке за полгода столбец выходил шириной в пару пикселей, и ряд
 * читался как частокол, в котором не видно ни хода, ни провалов. Линия с мягкой
 * заливкой показывает ровно те же числа, но формой, а форма при сотне точек
 * читается, а столбик — нет.
 *
 * Вторая ось справа здесь по-прежнему не появляется: все ряды на ОДНОЙ шкале,
 * иначе «линия выше линии» перестало бы что-либо значить.
 */
function buildOption(
  data: SeriesBucket[],
  groupBy: GroupBy,
  theme: ChartTheme,
  animate: boolean,
  selectedIndex: number,
  visible: ReadonlySet<MetricKey>,
): EChartsCoreOption {
  const labels = data.map((b) => formatKey(b.key, groupBy));
  const keys = data.map((b) => b.key);

  const shown = METRICS.filter((key) => visible.has(key));
  // Цвет закреплён за показателем (его слотом), а не за позицией среди
  // видимых: иначе погашенные «Лиды» перекрасили бы все остальные ряды.
  const colorOf = (key: MetricKey) => seriesColor(theme, METRICS.indexOf(key));
  const swatches = shown.map(colorOf);

  const line = (key: MetricKey, index: number) => {
    const color = colorOf(key);
    return {
      name: LABELS[key],
      type: 'line' as const,
      data: data.map((b) => b[key]),
      smooth: true,
      // Точки — только на разреженных рядах: на дневном ряду за полгода
      // сто кружков сливаются в сплошную ленту и прячут саму линию.
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
      // Полоса выбора висит на первом видимом ряду: на каждом — та же заливка
      // в несколько слоёв.
      ...(index === 0 && selectedIndex >= 0 ? { markArea: selectionMark(selectedIndex) } : {}),
    };
  };

  return {
    animation: animate,
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: CHART_FONT },
    // Легенды нет: ряды включаются переключателями над графиком (SeriesPicker),
    // и вторая панель с той же функцией только сбивала бы с толку. Оттого и
    // top меньше прежнего — место под легенду больше не нужно.
    grid: { left: 4, right: 8, top: 16, bottom: 4, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: GRID_LINE } },
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
      // boundaryGap=false — линия начинается у самой оси: у линейного ряда
      // отступы по краям оставляют пустые поля, которых нечем заполнить.
      boundaryGap: false,
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
    series: shown.map((key, index) => line(key, index)),
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
  // Выбор показателей живёт в компоненте графика: он ничего не меняет в
  // запросе за данными, это только про то, что сейчас на холсте.
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
    () => METRICS.map((key, slot) => ({
      key,
      label: LABELS[key],
      color: theme ? seriesColor(theme, slot) : 'transparent',
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
          ariaLabel="Лиды, квалификация, встречи и договоры по периодам"
          onSelectIndex={onSelectKey ? handleSelect : undefined}
          className={onSelectKey ? 'cursor-pointer' : undefined}
        />
      ) : (
        <div style={{ height: CHART_HEIGHT }} />
      )}
      <p className="mt-2 text-[11px] text-zinc-400">
        «Квал» — от лидов, пришедших в этот отрезок; встречи и договоры — по дате события.
      </p>
      <p className="mt-1 text-[11px] text-amber-700">
        Встречи — по записям из чата встреч, с 01.05.2026. Договоры — с 30.07.2026. Раньше данные недостоверны, поэтому линий нет.
      </p>
    </div>
  );
}
