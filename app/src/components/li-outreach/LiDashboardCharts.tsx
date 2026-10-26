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
  seriesColor,
  tooltipSkin,
  useChartTheme,
  usePrefersReducedMotion,
  verticalGradient,
  withAlpha,
  type ChartTheme,
} from '@/components/charts/theme';

/**
 * Графики дашборда LinkedIn Outreach — на той же ECharts и в том же стиле, что
 * дашборды TG-аутрича, «первички» и «Рассылки». Только отрисовка готовых чисел.
 */

export interface LiFunnel {
  new: number;
  invited: number;
  already_invited: number;
  connected: number;
  messaged: number;
  replied: number;
  completed: number;
  total: number;
}

export interface LiTimelineDay {
  date: string;
  invites: number;
  messages: number;
  errors: number;
}

const STAGES: { key: keyof LiFunnel; label: string }[] = [
  { key: 'new', label: 'Новые' },
  { key: 'invited', label: 'Приглашены' },
  { key: 'already_invited', label: 'Уже приглашены ранее' },
  { key: 'connected', label: 'Подключены' },
  { key: 'messaged', label: 'Написано' },
  { key: 'replied', label: 'Ответили' },
  { key: 'completed', label: 'Завершено' },
];

const ERROR_COLOR = '#ef4444';
// Сообщения зелёные: оранжевый из палитры сливался с красными ошибками.
const MESSAGE_COLOR = '#22c55e';

function funnelOption(funnel: LiFunnel, theme: ChartTheme, animate: boolean): EChartsCoreOption {
  const stages = STAGES.map((s) => ({ name: s.label, value: funnel[s.key] }));
  const total = Math.max(funnel.total, 1);
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
        const value = item.value ?? 0;
        return `<div style="font-weight:600">${item.name ?? ''}</div>
                <div style="margin-top:4px;font-variant-numeric:tabular-nums">${value}
                <span style="opacity:.7"> · ${Math.round((value / total) * 100)}% от всех контактов</span></div>`;
      },
    },
    series: [
      {
        type: 'funnel',
        left: 0,
        right: 0,
        top: 6,
        bottom: 6,
        minSize: '30%',
        maxSize: '96%',
        gap: 4,
        // Порядок ступеней задан смыслом воронки, а не величиной: «Уже приглашены
        // ранее» — боковая ветка и может быть больше соседей.
        sort: 'none',
        funnelAlign: 'center',
        label: {
          position: 'inside',
          color: '#ffffff',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: CHART_FONT,
          // Без толстой обводки: только лёгкая тень, чтобы белый текст читался на светлых ступенях.
          textBorderWidth: 0,
          textShadowColor: 'rgba(0, 0, 0, 0.35)',
          textShadowBlur: 3,
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

export function LiFunnelChart({ funnel, height = 340 }: { funnel: LiFunnel; height?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();
  const option = useMemo(
    () => (theme ? funnelOption(funnel, theme, !reducedMotion) : null),
    [funnel, theme, reducedMotion],
  );

  if (funnel.total === 0) return <p className="text-xs text-gray-400">Нет контактов</p>;
  return (
    <div ref={rootRef}>
      {option ? <EChart option={option} height={height} ariaLabel="Воронка контактов LinkedIn" /> : <div style={{ height }} />}
      <div className="mt-2 flex items-center gap-2 border-t border-gray-100 pt-2 text-xs text-gray-500">
        <span className="font-semibold text-gray-900">Всего {funnel.total}</span>
        <span>
          · конверсия в ответ:{' '}
          <span className="font-medium text-green-600">{Math.round((funnel.replied / funnel.total) * 100)}%</span>
        </span>
      </div>
    </div>
  );
}

function label(date: string): string {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function timelineOption(days: LiTimelineDay[], theme: ChartTheme, animate: boolean): EChartsCoreOption {
  const labels = days.map((d) => label(d.date));
  const hasErrors = days.some((d) => d.errors > 0);

  const area = (color: string) => ({
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
  });
  const line = (name: string, values: number[], color: string) => ({
    name,
    type: 'line' as const,
    data: values,
    smooth: true,
    symbol: 'circle',
    showSymbol: days.length <= 40,
    symbolSize: 6,
    lineStyle: { width: 2.5, color },
    itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
    areaStyle: area(color),
  });

  return {
    animation: animate,
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: CHART_FONT },
    grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: GRID_LINE } },
      ...tooltipSkin(theme),
    },
    xAxis: {
      type: 'category',
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
    series: [
      line('Инвайты', days.map((d) => d.invites), seriesColor(theme, 0)),
      line('Сообщения', days.map((d) => d.messages), MESSAGE_COLOR),
      ...(hasErrors ? [line('Ошибки', days.map((d) => d.errors), ERROR_COLOR)] : []),
    ],
  };
}

/** Инвайты, сообщения и ошибки по дням — то, что реально сделали аккаунты. */
export function LiInviteChart({ timeline, height = 240 }: { timeline: LiTimelineDay[]; height?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();
  const option = useMemo(
    () => (theme ? timelineOption(timeline, theme, !reducedMotion) : null),
    [timeline, theme, reducedMotion],
  );

  return (
    <div ref={rootRef}>
      {option ? <EChart option={option} height={height} ariaLabel="Инвайты и сообщения LinkedIn по дням" /> : <div style={{ height }} />}
    </div>
  );
}
