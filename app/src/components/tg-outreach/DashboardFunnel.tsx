'use client';

import { useMemo, useRef } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import EChart from '@/components/charts/EChart';
import {
  CHART_FONT,
  seriesColor,
  tooltipSkin,
  useChartTheme,
  usePrefersReducedMotion,
  verticalGradient,
  type ChartTheme,
} from '@/components/charts/theme';
import type { FunnelStage } from '@/lib/tgOutreach/dashboard';

/**
 * Воронка кампании: контактов в базе → отправлено → ответили → целевые →
 * переданы менеджеру.
 *
 * Сами ступени и конверсию между ними (`fromPrev`) считает
 * buildCampaignDashboard (dashboard.ts) — теми же предикатами, что и отчёт по
 * договору. Здесь только отрисовка уже готовых чисел, без пересчёта: два
 * экрана с разными цифрами про одно и то же хуже, чем отсутствие второго.
 *
 * Конверсия в тултипе — от ПРЕДЫДУЩЕГО шага, не от первого: `fromPrev = null`
 * рисуется прочерком, а не «0%» — нулевая конверсия и отсутствие рассылки
 * читаются очень по-разному.
 */

function buildOption(stages: FunnelStage[], theme: ChartTheme, animate: boolean): EChartsCoreOption {
  const prevByName = new Map<string, FunnelStage>();
  stages.forEach((stage, i) => {
    if (i > 0) prevByName.set(stage.name, stages[i - 1]);
  });
  const stageByName = new Map(stages.map((s) => [s.name, s]));

  return {
    animation: animate,
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: CHART_FONT },
    tooltip: {
      trigger: 'item',
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const item = params as { name?: string; value?: number };
        const stage = item.name ? stageByName.get(item.name) : undefined;
        const value = stage?.value ?? item.value ?? 0;
        const prev = item.name ? prevByName.get(item.name) : undefined;
        const step = prev
          ? `<div style="margin-top:2px;opacity:.7">из «${prev.name}» — ${
              stage?.fromPrev == null ? '—' : `${stage.fromPrev}%`
            }</div>`
          : '';
        return `<div style="font-weight:600">${item.name ?? ''}</div>
                <div style="margin-top:4px;font-variant-numeric:tabular-nums">${value}</div>${step}`;
      },
    },
    series: [
      {
        type: 'funnel',
        left: 0,
        right: 0,
        top: 10,
        bottom: 10,
        minSize: '38%',
        maxSize: '92%',
        gap: 4,
        // `none`, а не `descending`: порядок ступеней задан смыслом воронки, а
        // не величиной. Сортировка по значению переставила бы шаги местами,
        // как только поздний этап (например, «Переданы») оказался бы больше
        // раннего, — и воронка перестала бы быть воронкой.
        sort: 'none',
        funnelAlign: 'center',
        label: {
          position: 'inside',
          color: '#ffffff',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: CHART_FONT,
          formatter: (params: unknown) => {
            const item = params as { name?: string; value?: number };
            return `${item.name ?? ''} — ${item.value ?? 0}`;
          },
        },
        labelLine: { show: false },
        itemStyle: { borderWidth: 0, borderRadius: 4 },
        data: stages.map((stage, i) => ({
          name: stage.name,
          value: stage.value,
          itemStyle: { color: verticalGradient(seriesColor(theme, i), 0.55) },
        })),
      },
    ],
  };
}

export default function DashboardFunnel({ funnel }: { funnel: FunnelStage[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const option = useMemo(
    () => (theme ? buildOption(funnel, theme, !reducedMotion) : null),
    [funnel, theme, reducedMotion],
  );

  // Первая ступень — «Контактов в базе» за период. Ноль здесь значит, что
  // смотреть вообще не на что, а не «всё сорвалось на первом шаге»: рисовать
  // пустую воронку в этом случае только запутывает.
  const empty = (funnel[0]?.value ?? 0) === 0;

  return (
    <div ref={rootRef} className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-1 text-sm font-semibold text-gray-800">Воронка</h3>
      {empty ? (
        <div className="px-3 py-10 text-center text-sm text-gray-400">
          За выбранный период контактов нет.
        </div>
      ) : option ? (
        <div className="mx-auto w-full max-w-[680px]">
          <EChart
            option={option}
            height={280}
            ariaLabel="Воронка кампании: контакты в базе, отправлено, ответили, целевые, переданы менеджеру"
          />
        </div>
      ) : (
        <div style={{ height: 280 }} />
      )}
    </div>
  );
}
