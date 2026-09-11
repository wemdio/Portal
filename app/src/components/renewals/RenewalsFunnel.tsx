'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { RenewalsFunnel as FunnelData } from '@/lib/renewals/funnel';
import RenewalsDealsList from '@/components/renewals/RenewalsDealsList';

/**
 * Воронка вторичных продаж — из воронки AMO «Вторичные (и не только) продажи».
 *
 * Ступени идут в порядке этапов, а не по величине: сортировка по числу
 * переставила бы их местами, и воронка перестала бы быть воронкой.
 *
 * С 11.09.2026 компонент общий для продлений и первички: у обоих дашбордов
 * одна схема «этап каждой сделки на последний день периода», отличаются только
 * ручка данных и подписи — они приходят пропсами, умолчания — продлений.
 *
 * «Пауза», «Реанимация» и «Отвал» в ступени не входят — это исходы, а не
 * продолжение пути: проект попадает туда ВМЕСТО продления. Они показаны
 * отдельной строкой под воронкой.
 */

/**
 * Долей «сколько дошло от предыдущего этапа» здесь нет намеренно.
 *
 * С 11.09.2026 ступень — это сколько сделок стояло на этапе в последний день
 * периода, то есть распределение, а не вложенная воронка. Отношение соседних чисел в ней — не
 * конверсия, и показывать его процентом значит выдавать за неё случайную дробь.
 */
function buildOption(data: FunnelData, theme: ChartTheme, animate: boolean): EChartsCoreOption {
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
        const word = value === 1 ? 'сделка' : value >= 2 && value <= 4 ? 'сделки' : 'сделок';
        return `<div style="font-weight:600">${item.name ?? ''}</div>
                <div style="margin-top:4px;font-variant-numeric:tabular-nums">${value} ${word} на этапе в конце периода</div>`;
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
        data: data.stages.map((stage, i) => ({
          name: stage.name,
          value: stage.reached,
          // Слоты палитры по кругу: этапов больше, чем цветов, а смысловой
          // привязки цвета к этапу здесь нет — важен только порядок.
          itemStyle: { color: verticalGradient(seriesColor(theme, i % 6), 0.55) },
        })),
      },
    ],
  };
}

const RENEWALS_DEFAULTS = {
  endpoint: '/api/analytics/renewals/funnel',
  dealEndpoint: '/api/analytics/renewals/deal',
  title: 'Воронка вторичных продаж за период',
  subtitle: 'На каком этапе была каждая сделка в последний день периода. История переходов — в карточке сделки.',
  emptyText:
    'За выбранный период в этой воронке ничего не двигалось. Проекты попадают в неё автоматически, '
    + 'когда сделка закрывается успешно в основной воронке, — попробуйте расширить период.',
  ariaLabel: 'Воронка вторичных продаж по этапам AMO',
  outcomesLabel: 'Вне пути:',
  listSubtitle:
    'Каждая сделка — на этапе, где была в последний день периода. Клик открывает карточку с историей переходов. '
    + 'Внизу — сделки на паузе, в реанимации или отвале.',
  listOutcomesLabel: 'Вне пути',
};

/** Разделитель ключей каналов в зависимости эффекта: запятая может встретиться в самом ключе. */
const SOURCES_SEPARATOR = '\u0001';

export default function RenewalsFunnel({
  filters,
  endpoint = RENEWALS_DEFAULTS.endpoint,
  dealEndpoint = RENEWALS_DEFAULTS.dealEndpoint,
  title = RENEWALS_DEFAULTS.title,
  subtitle = RENEWALS_DEFAULTS.subtitle,
  emptyText = RENEWALS_DEFAULTS.emptyText,
  ariaLabel = RENEWALS_DEFAULTS.ariaLabel,
  outcomesLabel = RENEWALS_DEFAULTS.outcomesLabel,
  listSubtitle = RENEWALS_DEFAULTS.listSubtitle,
  listOutcomesLabel = RENEWALS_DEFAULTS.listOutcomesLabel,
}: {
  /** Период и — у первички — фильтр каналов. Остальные поля фильтров экрана воронке не нужны. */
  filters: { from: string; to: string; sources?: string[] };
  endpoint?: string;
  dealEndpoint?: string;
  title?: string;
  subtitle?: string;
  emptyText?: string;
  ariaLabel?: string;
  outcomesLabel?: string;
  listSubtitle?: string;
  listOutcomesLabel?: string;
}) {
  const sourcesKey = (filters.sources ?? []).join(SOURCES_SEPARATOR);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to });
        for (const source of sourcesKey ? sourcesKey.split(SOURCES_SEPARATOR) : []) qs.append('source', source);
        const res = await authFetch(`${endpoint}?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as FunnelData;
        if (!active) return;
        setError(null);
        setData(json);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        logError('renewals.funnel.fetch_failed', e);
        setError(e instanceof Error ? e.message : 'Не удалось загрузить воронку');
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [endpoint, filters.from, filters.to, sourcesKey]);

  const option = useMemo(
    () => (theme && data && data.totalDeals > 0 ? buildOption(data, theme, !reducedMotion) : null),
    [data, theme, reducedMotion],
  );

  const outcomes = data?.outcomes.filter((o) => o.count > 0) ?? [];

  return (
    // Воронка слева, сделки справа — та же раскладка, что на дашборде
    // первички: воронка нарисована в центре широкого пустого поля и на
    // половине ширины ничего не теряет, а список отвечает на следующий же
    // вопрос — «а кто это?». На узком экране список уезжает вниз.
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div ref={rootRef} className="glass-tile p-3">
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        {/* Правило отбора обязано быть написано на экране: без него цифры
            воронки и плиток выше читаются как расхождение, хотя это разные
            вопросы — «где сделки на конец периода» и «за что заплатили в периоде». */}
        <p className="mb-2 text-[11px] text-zinc-400">
          {subtitle}
        </p>

        {loading ? <div className="px-3 py-10 text-center text-sm text-zinc-400">Загружаю…</div> : null}

        {error && !loading ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            Ошибка загрузки: {error}
          </div>
        ) : null}

        {!loading && !error && data && data.totalDeals === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-zinc-400">
            {emptyText}
          </p>
        ) : null}

        {option ? (
          <div className="mx-auto w-full max-w-[680px]">
            <EChart option={option} height={400} ariaLabel={ariaLabel} />
          </div>
        ) : null}

        {outcomes.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500">
            {/* Исходы вне воронки: проект попадает туда вместо продления, и
                ступенью это быть не может — иначе отвалившиеся посчитались бы
                продлёнными просто потому, что их этап ниже по порядку. Считаем
                тем же правилом, что ступени: сколько сделок стояло там в конце периода. */}
            <span className="text-zinc-400">{outcomesLabel}</span>
            {outcomes.map((outcome) => (
              <span key={outcome.statusId}>
                {outcome.name} — <span className="font-semibold text-zinc-700">{outcome.count}</span>
              </span>
            ))}
          </div>
        ) : null}

        {data && data.backfilledCount > 0 ? (
          // Продлены по-настоящему, но пути не проходили: карточки заведены сразу
          // на «Продлено» по портальным проектам. В ступенях они дали бы 100% на
          // каждом шаге, поэтому стоят отдельным числом.
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500">
            <span>
              Продлено раньше воронки —{' '}
              <span className="font-semibold text-zinc-700">{data.backfilledCount}</span>
            </span>
            <span className="text-zinc-400">
              заведены по проектам портала задним числом, поэтому в конверсию по этапам не входят
            </span>
          </div>
        ) : null}
      </div>

      {data && (data.dealGroups.length > 0 || data.outcomeGroups.length > 0) ? (
        <RenewalsDealsList
          groups={data.dealGroups}
          outcomeGroups={data.outcomeGroups}
          dealEndpoint={dealEndpoint}
          subtitle={listSubtitle}
          outcomesLabel={listOutcomesLabel}
        />
      ) : null}
    </div>
  );
}
