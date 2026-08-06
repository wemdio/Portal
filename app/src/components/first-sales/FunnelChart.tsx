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
import type { FirstSalesTotals } from '@/lib/firstSales/metrics';

/**
 * Воронка первички: лиды → квалификация → встречи → договоры.
 *
 * Показывает то, чего не показывает график по времени: не «сколько было в
 * каждом месяце», а «сколько дошло от этапа к этапу» за весь выбранный период.
 *
 * Этап, данные которого за это окно недостоверны, из воронки ВЫБРАСЫВАЕТСЯ, а
 * не рисуется нулём. Ноль здесь читался бы как «ни одной встречи не было»,
 * тогда как на деле мы просто отказались считать грязные данные (см.
 * `meetingsReliable` / `contractsReliable` в metrics.ts). Вместо ступени —
 * подпись под воронкой, объясняющая, с какой даты этап считается.
 */

interface Stage {
  name: string;
  value: number;
  slot: number;
}

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatSince(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_FMT.format(date);
}

function buildOption(stages: Stage[], theme: ChartTheme, animate: boolean): EChartsCoreOption {
  const top = stages[0]?.value ?? 0;
  const prevByName = new Map<string, Stage>();
  stages.forEach((stage, i) => {
    if (i > 0) prevByName.set(stage.name, stages[i - 1]);
  });

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
        const share = top > 0 ? Math.round((value / top) * 100) : 0;
        const prev = item.name ? prevByName.get(item.name) : undefined;
        const step =
          prev && prev.value > 0
            ? `<div style="margin-top:2px;opacity:.7">из «${prev.name}» — ${Math.round(
                (value / prev.value) * 100,
              )}%</div>`
            : '';
        return `<div style="font-weight:600">${item.name ?? ''}</div>
                <div style="margin-top:4px;font-variant-numeric:tabular-nums">${value} · ${share}% от лидов</div>${step}`;
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
        // `none`, а не `descending`. Сортировка по величине переставляет
        // ступени местами, как только более поздний этап оказывается больше
        // раннего, — и воронка перестаёт быть воронкой: порядок этапов сделки
        // подменяется рейтингом чисел. Порядок здесь задаётся смыслом.
        sort: 'none',
        funnelAlign: 'center',
        label: {
          position: 'inside',
          color: '#ffffff',
          fontSize: 14,
          fontWeight: 600,
          fontFamily: CHART_FONT,
          formatter: (params: unknown) => {
            const item = params as { name?: string; value?: number };
            const value = item.value ?? 0;
            const share = top > 0 ? Math.round((value / top) * 100) : 0;
            return `${item.name ?? ''} — ${value} · ${share}%`;
          },
        },
        labelLine: { show: false },
        itemStyle: { borderWidth: 0, borderRadius: 4 },
        data: stages.map((stage) => ({
          name: stage.name,
          value: stage.value,
          itemStyle: { color: verticalGradient(seriesColor(theme, stage.slot), 0.55) },
        })),
      },
    ],
  };
}

export default function FunnelChart({ totals }: { totals: FirstSalesTotals }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const stages = useMemo<Stage[]>(() => {
    const list: Stage[] = [
      { name: 'Лиды', value: totals.leads, slot: 0 },
      { name: 'Квал', value: totals.qualified, slot: 1 },
    ];
    if (totals.meetingsReliable) list.push({ name: 'Встречи', value: totals.meetings, slot: 2 });
    if (totals.contractsReliable) list.push({ name: 'Договоры', value: totals.contracts, slot: 3 });
    return list;
  }, [totals]);

  const option = useMemo(
    () => (theme ? buildOption(stages, theme, !reducedMotion) : null),
    [stages, theme, reducedMotion],
  );

  const hidden: string[] = [];
  if (!totals.meetingsReliable) hidden.push(`встречи считаются с ${formatSince(totals.meetingsSince)}`);
  if (!totals.contractsReliable) hidden.push(`договоры считаются с ${formatSince(totals.contractsSince)}`);

  // Ступень шире предыдущей — не ошибка отрисовки, а разная логика подсчёта:
  // «квал» кладётся когортно, по дате прихода лида, а встречи и договоры — по
  // дате самого события. В одном окне встреч может оказаться больше, чем
  // квалификаций. Без объяснения такой выступ читается как баг.
  const widened = stages
    .filter((stage, i) => i > 0 && stage.value > stages[i - 1].value)
    .map((stage) => `«${stage.name}»`);

  return (
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
      <h3 className="mb-1 text-sm font-semibold text-zinc-900">Воронка за период</h3>
      {totals.leads === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-zinc-400">Лидов за выбранный период нет.</div>
      ) : option ? (
        // Ширина ограничена и отцентрована: на всю ширину экрана воронка
        // вырождается в почти горизонтальные полосы, а верхняя ступень — в
        // острый клин от края до края.
        <div className="mx-auto w-full max-w-[680px]">
          <EChart option={option} height={320} ariaLabel="Воронка: лиды, квалификация, встречи, договоры" />
        </div>
      ) : (
        <div style={{ height: 320 }} />
      )}
      {widened.length > 0 ? (
        <p className="mt-2 text-[11px] text-zinc-400">
          {widened.join(', ')} шире предыдущей ступени: «Квал» считается когортно — из лидов, пришедших в этот период,
          — а встречи и договоры по дате самого события. Поэтому в одном окне встреча может быть у лида, пришедшего
          раньше, и ступень оказывается шире. Это не ошибка графика.
        </p>
      ) : null}
      {hidden.length > 0 ? (
        <p className="mt-2 text-[11px] text-amber-700">
          Часть ступеней не показана, потому что за это окно они недостоверны: {hidden.join('; ')}. Ноль вместо
          ступени читался бы как «этого не было», а это не так — мы просто отказались считать неполные данные.
        </p>
      ) : null}
    </div>
  );
}
