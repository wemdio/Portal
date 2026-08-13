'use client';

/**
 * Вкладка «Сводка» — первый экран кампании: отвечает разом на два вопроса,
 * сколько кампания принесла и жива ли она сейчас. Открывается один раз и
 * читается — автообновления нет намеренно (см. спеку), это не «Прогрев», где
 * идёт процесс.
 *
 * Всю арифметику отдаёт роут `campaigns/[id]/dashboard`: воронку и ряды
 * графика — buildCampaignDashboard, здоровье аккаунтов — summarizeAccounts.
 * Здесь только раскладка уже готовых чисел, ничего не пересчитывается.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { AlertCircle, Loader2 } from 'lucide-react';

import { authFetch } from '@/lib/authFetch';
import EChart from '@/components/charts/EChart';
import {
  AXIS_FONT_SIZE,
  AXIS_LINE,
  AXIS_TEXT,
  CHART_FONT,
  GRID_LINE,
  LEGEND_FONT_SIZE,
  seriesColor,
  tooltipSkin,
  useChartTheme,
  usePrefersReducedMotion,
  type ChartTheme,
} from '@/components/charts/theme';
import DashboardFunnel from './DashboardFunnel';
import {
  TZ_OFFSET_HOURS,
  type CampaignDashboard,
  type DashboardDay,
  type DashboardPeriod,
} from '@/lib/tgOutreach/dashboard';
import type { AccountsSummary } from '@/lib/tgOutreach/accountsSummary';

const API_BASE = '/api/tools/tg-outreach';

interface DashboardErrorRow {
  message: string;
  count: number;
}

interface DashboardApiResponse {
  period: DashboardPeriod;
  dashboard: CampaignDashboard;
  accounts: AccountsSummary;
  accounts_total: number;
  warming: number;
  errors: DashboardErrorRow[];
}

const PERIOD_OPTIONS: Array<{ id: DashboardPeriod; label: string }> = [
  { id: '1d', label: '1 день' },
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
  { id: 'all', label: 'Всё время' },
];

/**
 * Стартовые даты «своего периода»: с первого числа текущего месяца по сегодня.
 * Считаем в том же поясе (+3), в котором dashboard.ts режет сутки, иначе
 * поздним вечером по Москве подставился бы вчерашний день.
 */
function defaultCustomRange(): { from: string; to: string } {
  const msk = new Date(Date.now() + TZ_OFFSET_HOURS * 3_600_000);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

/** «13.08» в том же поясе (+3), в котором dashboard.ts режет сутки. */
function formatDayLabel(iso: string): string {
  const d = new Date(new Date(iso).getTime() + TZ_OFFSET_HOURS * 3_600_000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

const DAILY_LABELS = ['Отправлено', 'Ответы', 'Лиды', 'Блокировки'] as const;

function buildDailyOption(days: DashboardDay[], theme: ChartTheme, animate: boolean): EChartsCoreOption {
  const labels = days.map((d) => formatDayLabel(d.date));
  const swatches = [0, 1, 2, 3].map((slot) => seriesColor(theme, slot));

  const line = (name: string, values: number[], slot: number, dashed: boolean) => ({
    name,
    type: 'line' as const,
    data: values,
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    lineStyle: {
      width: dashed ? 2 : 2.5,
      color: swatches[slot],
      type: (dashed ? 'dashed' : 'solid') as 'dashed' | 'solid',
    },
    itemStyle: { color: swatches[slot], borderColor: theme.surface, borderWidth: 1.5 },
  });

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
      axisPointer: { type: 'line', lineStyle: { color: GRID_LINE } },
      ...tooltipSkin(theme),
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as Array<{
          seriesName?: string;
          value?: number;
          dataIndex?: number;
          seriesIndex?: number;
        }>;
        const index = items[0]?.dataIndex ?? 0;
        const rows = items
          .map(
            (item) => `
              <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                <span style="width:10px;height:10px;border-radius:3px;background:${
                  swatches[item.seriesIndex ?? 0] ?? 'transparent'
                };flex:none"></span>
                <span style="opacity:.75">${item.seriesName ?? ''}</span>
                <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600">${item.value ?? 0}</span>
              </div>`,
          )
          .join('');
        return `<div style="font-weight:600">${labels[index] ?? ''}</div>${rows}`;
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
      line(DAILY_LABELS[0], days.map((d) => d.delivered), 0, false),
      line(DAILY_LABELS[1], days.map((d) => d.replies), 1, false),
      line(DAILY_LABELS[2], days.map((d) => d.leads), 2, false),
      // Блокировки — пунктиром: это не ещё один объём, а сигнал тревоги.
      // Всплеск на фоне ровной отправки виден лучше, если линия визуально
      // отличается от трёх «хороших» рядов, а не просто занимает четвёртый слот.
      line(DAILY_LABELS[3], days.map((d) => d.blocks), 3, true),
    ],
  };
}

/** График по дням: отправлено, ответы, лиды, блокировки. Локальный — отдельного файла не заводим. */
function DailyActivityChart({ days }: { days: DashboardDay[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  const option = useMemo(
    () => (theme ? buildDailyOption(days, theme, !reducedMotion) : null),
    [days, theme, reducedMotion],
  );

  return (
    <div ref={rootRef} className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-1 text-sm font-semibold text-gray-800">Динамика по дням</h3>
      {option ? (
        <EChart
          option={option}
          height={260}
          ariaLabel="Динамика по дням: отправлено, ответы, лиды, блокировки"
        />
      ) : (
        <div style={{ height: 260 }} />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  caption,
}: {
  label: string;
  value: string | number;
  tone?: 'good' | 'warn' | 'danger' | 'info';
  caption?: string;
}) {
  const toneCls =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'danger'
          ? 'text-rose-600'
          : tone === 'info'
            ? 'text-indigo-600'
            : 'text-gray-800';
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2.5">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`mt-0.5 text-lg font-medium ${toneCls}`}>{value}</div>
      {caption ? <div className="mt-0.5 text-[10px] text-gray-400">{caption}</div> : null}
    </div>
  );
}

export default function DashboardTab({ campaignId }: { campaignId: string }) {
  const [period, setPeriod] = useState<DashboardPeriod>('7d');
  /**
   * Произвольный период. null — работает выбранный пресет. Отдельным
   * состоянием, а не пятым значением `DashboardPeriod`: пресет и пара дат —
   * разные по форме вещи, и объединение их в одно поле заставило бы каждого
   * читателя выяснять, что сейчас лежит внутри.
   */
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<DashboardApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Инлайновый IIFE, а не вынесенный useCallback: линтер отдельно предупреждает
  // о setState прямо в теле эффекта, когда эффект зовёт вынесенную функцию по
  // ссылке. Тот же приём уже используется в WarmupTab.tsx.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = custom
          ? `period=${period}&from=${custom.from}&to=${custom.to}`
          : `period=${period}`;
        const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/dashboard?${qs}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Не удалось загрузить сводку (${res.status})`);
          return;
        }
        setData((await res.json()) as DashboardApiResponse);
      } catch {
        setError('Не удалось загрузить сводку');
      } finally {
        setLoading(false);
      }
    })();
  }, [campaignId, period, custom]);

  // Разбивка мёртвых аккаунтов по причине — та же строка, что summarizeAccounts
  // уже посчитал, просто в читаемом виде под карточкой «Мертвы».
  const deadCaption = useMemo(() => {
    if (!data) return undefined;
    const entries = Object.entries(data.accounts.byStatus);
    if (!entries.length) return undefined;
    return entries.map(([status, count]) => `${status}: ${count}`).join(', ');
  }, [data]);

  return (
    <div className="space-y-3 p-4">
      {/* Переключатель периода */}
      <div className="flex items-center rounded-xl border border-gray-200 bg-white px-3 py-2">
        <div className="flex items-center gap-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={loading}
              onClick={() => { setPeriod(opt.id); setCustom(null); }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                period === opt.id && !custom
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {opt.label}
            </button>
          ))}

          {/* Свой период. По умолчанию — с первого числа текущего месяца по
              сегодня: чаще всего спрашивают именно «что накопилось в этом
              месяце», а пресета под это нет. */}
          <button
            type="button"
            disabled={loading}
            onClick={() => setCustom((cur) => (cur ? null : defaultCustomRange()))}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
              custom ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            Свой период
          </button>
        </div>

        {custom && (
          <div className="ml-3 flex items-center gap-1.5">
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              disabled={loading}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
            />
            <span className="text-xs text-gray-400">—</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              disabled={loading}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
            />
            <span className="text-[10px] text-gray-400">включительно</span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-8 text-xs text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Загружаю сводку…
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800">
          <AlertCircle className="mt-px h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : data ? (
        <>
          {/* Воронка + блокировки рядом, но не в ней: это сигнал «пережали
              с темпом», а не полезный шаг рассылки. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
            <DashboardFunnel funnel={data.dashboard.funnel} />
            {/* Красным — только когда есть о чём тревожиться. Ноль в красной
                рамке читается как авария, которой нет. */}
            <div
              className={`flex flex-col items-start justify-center gap-1 rounded-xl border p-4 ${
                data.dashboard.blocks > 0
                  ? 'border-rose-200 bg-rose-50'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <span
                className={`text-xs font-medium ${
                  data.dashboard.blocks > 0 ? 'text-rose-600' : 'text-gray-500'
                }`}
              >
                Заблокировали нас
              </span>
              <span
                className={`text-2xl font-semibold ${
                  data.dashboard.blocks > 0 ? 'text-rose-700' : 'text-gray-800'
                }`}
              >
                {data.dashboard.blocks}
              </span>
              {/* Прежняя подпись объясняла, чем цифра НЕ является («не шаг
                  воронки»), и не говорила, что она значит. Читателю нужно
                  обратное. Оговорка про занижение — в подсказке: она важна для
                  того, кто принимает решение по цифре, но в плитке не
                  помещается. */}
              <span
                title={
                  'Считаем по диалогам, где Telegram отказал в отправке с кодом «пользователь заблокировал». '
                  + 'Узнаём об этом только в момент следующей попытки написать, поэтому число заведомо неполное: '
                  + 'кто заблокировал после последней реплики цепочки, сюда не попадёт. '
                  + 'Удалённые аккаунты и прочая недоступность считаются отдельно и сюда не входят.'
                }
                className={`cursor-help text-[10px] leading-snug ${
                  data.dashboard.blocks > 0 ? 'text-rose-500' : 'text-gray-400'
                }`}
              >
                {data.dashboard.blocks > 0
                  ? 'получателей закрыли доступ аккаунту, с которого им писали. Растёт — снижайте темп'
                  : 'никто не закрыл доступ аккаунтам, с которых писали. Растёт — значит пережали с темпом'}
              </span>
            </div>
          </div>

          <DailyActivityChart days={data.dashboard.days} />

          {/* Здоровье кампании */}
          <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-gray-800">Здоровье кампании</h3>

            <div className="text-[11px] font-medium text-gray-400">Аккаунты</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Metric label="Живы" value={data.accounts.alive} tone="good" />
              <Metric
                label="Мертвы"
                value={data.accounts.dead}
                tone={data.accounts.dead > 0 ? 'danger' : undefined}
                caption={deadCaption}
              />
              <Metric label="Не проверялись" value={data.accounts.unchecked} />
              <Metric label="Выключены" value={data.accounts.disabled} />
              <Metric
                label="Греются"
                value={data.warming}
                tone={data.warming > 0 ? 'info' : undefined}
                caption={`из ${data.accounts_total} всего`}
              />
            </div>

            <div className="text-[11px] font-medium text-gray-400">Темп</div>
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Отправлено сегодня" value={data.dashboard.pace.sentToday} />
              <Metric label="Вчера" value={data.dashboard.pace.sentYesterday} />
              <Metric label="Среднесуточно" value={data.dashboard.pace.perDay} />
            </div>

            <div className="text-[11px] font-medium text-gray-400">Остаток базы</div>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Осталось контактов" value={data.dashboard.base.remaining} />
              <Metric
                label="Хватит на"
                value={data.dashboard.base.daysLeft === null ? '—' : `${data.dashboard.base.daysLeft} дн.`}
                caption={data.dashboard.base.daysLeft === null ? 'темп нулевой' : undefined}
              />
            </div>
          </div>

          {/* Свежие ошибки за сутки */}
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-800">Свежие ошибки за сутки</h3>
            {data.errors.length === 0 ? (
              <div className="py-4 text-center text-xs text-gray-400">За сутки ошибок не было</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.errors.map((e, i) => (
                  <li key={i} className="flex items-center gap-3 py-2">
                    <span className="flex-1 truncate text-xs text-gray-700">{e.message}</span>
                    <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                      × {e.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
