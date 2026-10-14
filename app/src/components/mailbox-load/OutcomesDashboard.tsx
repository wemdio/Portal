'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import EChart from '@/components/charts/EChart';
import SeriesPicker from '@/components/charts/SeriesPicker';
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
  withAlpha,
  type ChartTheme,
} from '@/components/charts/theme';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { MailboxOutcomes, OutcomeDay } from '@/lib/instantly/mailboxOutcomes';

/**
 * «Что принесли отправки» — блок внизу страницы «Нагрузка почт».
 *
 * Верх страницы отвечает, выбран ли дневной потолок ящиков; этот блок — что из
 * этих писем вышло: сколько ушло, сколько не доехало, сколько ответили и
 * сколько ответов оказались лидами (просьба Ника 09.10.2026).
 *
 * Грузится своим запросом, а не вместе с нагрузкой: запросы к датасету тяжелее,
 * и таблица ящиков не должна их ждать. Своя ошибка тоже остаётся своей —
 * страница выше продолжает работать.
 */

type MetricKey = 'sent' | 'negative' | 'replies' | 'leads';

const LABELS: Record<MetricKey, string> = {
  sent: 'Отправлено',
  negative: 'Не доставлено',
  replies: 'Ответы',
  leads: 'Лиды',
};

const METRICS: MetricKey[] = ['sent', 'negative', 'replies', 'leads'];

/** Слот палитры у каждого показателя: цвет закреплён и не зависит от того,
 *  какие ряды сейчас включены. */
const SLOT: Record<MetricKey, number> = { sent: 0, negative: 1, replies: 2, leads: 3 };

const CHART_HEIGHT = 300;

const nf = (n: number) => n.toLocaleString('ru-RU');

function share(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${(Math.round((part / whole) * 1000) / 10).toLocaleString('ru-RU')}%`;
}

function formatDay(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

/** Негатив = отбой при доставке + разобранный ответ «не тот человек/адрес». */
function negativeOf(d: OutcomeDay): number {
  return d.bounced + d.invalid;
}

function Tile({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub: string;
  tone?: 'bad' | null;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone === 'bad' ? 'border-red-200 bg-red-50' : 'border-zinc-200 bg-white'}`}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone === 'bad' ? 'text-red-700' : 'text-zinc-900'}`}>{value}</p>
      <p className="text-[11px] text-zinc-400">{sub}</p>
    </div>
  );
}

function buildOption(
  days: OutcomeDay[],
  theme: ChartTheme,
  animate: boolean,
  visible: ReadonlySet<MetricKey>,
): EChartsCoreOption {
  const labels = days.map((d) => formatDay(d.day));
  const values: Record<MetricKey, number[]> = {
    sent: days.map((d) => d.sent),
    negative: days.map(negativeOf),
    replies: days.map((d) => d.replies),
    leads: days.map((d) => d.leads),
  };
  const shown = METRICS.filter((key) => visible.has(key));
  const colorOf = (key: MetricKey) => seriesColor(theme, SLOT[key]);
  const axisLabel = { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT };

  return {
    animation: animate,
    animationDuration: 700,
    textStyle: { fontFamily: CHART_FONT },
    grid: { left: 4, right: 4, top: 16, bottom: 4, containLabel: true },
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
      axisLabel,
    },
    // Две шкалы: писем уходят тысячи, ответов и лидов — единицы, и на общей
    // оси последние лежали бы по нулю. Левая — письма, у остальных своя шкала
    // без подписей (вторая колонка чисел читалась бы как продолжение первой),
    // числа видно в подсказке.
    yAxis: [
      { type: 'value', name: 'письма', minInterval: 1, nameTextStyle: axisLabel, splitLine: { lineStyle: { color: GRID_LINE } }, axisLabel },
      { type: 'value', minInterval: 1, splitLine: { show: false }, axisLabel: { show: false } },
    ],
    series: shown.map((key) => {
      const color = colorOf(key);
      return {
        name: LABELS[key],
        type: 'line' as const,
        yAxisIndex: key === 'sent' ? 0 : 1,
        data: values[key],
        smooth: true,
        symbol: 'circle',
        showSymbol: false,
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
              { offset: 0, color: withAlpha(color, 0.22) },
              { offset: 1, color: withAlpha(color, 0) },
            ],
          },
        },
      };
    }),
  };
}

export default function OutcomesDashboard({ day }: { day: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();
  const [data, setData] = useState<MailboxOutcomes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<ReadonlySet<MetricKey>>(() => new Set(METRICS));

  // Фетч в эффекте; спиннер даёт initial loading=true. Повторно его здесь не
  // ставим (это setState в эффекте, лишний каскад и предупреждение правила):
  // при смене дня страница монтирует блок заново по key — состояние и так
  // начинается с загрузки.
  useEffect(() => {
    if (!day) return;
    let active = true;
    const run = async () => {
      try {
        const res = await authFetch(`/api/analytics/mailbox-load/outcomes?day=${encodeURIComponent(day)}`);
        const body = (await res.json().catch(() => null)) as { data: MailboxOutcomes | null; error?: string; detail?: string } | null;
        if (!res.ok) {
          const code = body?.error || `HTTP ${res.status}`;
          throw new Error(body?.detail ? `${code} — ${body.detail}` : code);
        }
        if (!active) return;
        setError(null);
        setData(body?.data ?? null);
      } catch (e) {
        if (!active) return;
        logError('mailbox-load outcomes failed', e);
        setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => { active = false; };
  }, [day]);

  const option = useMemo(
    () => (theme && data ? buildOption(data.days, theme, !reducedMotion, visible) : null),
    [theme, data, reducedMotion, visible],
  );

  const pickerItems = useMemo(
    () => METRICS.map((key) => ({
      key,
      label: LABELS[key],
      color: theme ? seriesColor(theme, SLOT[key]) : 'transparent',
    })),
    [theme],
  );

  const t = data?.totals;
  const negative = t ? t.bounced + t.invalid : 0;

  return (
    <div ref={rootRef} className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">Что принесли отправки</h2>
        <p className="text-xs text-zinc-500">За тот же день, что и таблица выше; на графике — он и 29 дней до него.</p>
      </div>

      {loading && <div className="py-8 text-center text-sm text-zinc-400">Загрузка…</div>}
      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Не удалось посчитать исходы: {error}
        </div>
      )}

      {!loading && !error && data && t && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Отправлено" value={nf(t.sent)} sub="писем за день" />
            <Tile
              label="Не доставлено"
              value={data.bounceUnavailable && t.invalid === 0 ? '—' : nf(negative)}
              sub={`отбои ${data.bounceUnavailable ? '—' : nf(t.bounced)} · невалидных ${nf(t.invalid)} · ${share(negative, t.sent)} от писем`}
              tone={t.sent > 0 && negative / t.sent > 0.05 ? 'bad' : null}
            />
            <Tile label="Ответы" value={nf(t.replies)} sub={`${share(t.replies, t.sent)} от писем, по людям`} />
            <Tile label="Лиды" value={nf(t.leads)} sub={`${share(t.leads, t.replies)} от ответов`} />
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <SeriesPicker items={pickerItems} visible={visible} onToggle={(key) => {
              setVisible((cur) => {
                const next = new Set(cur);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            }} className="mb-2" />
            {option ? (
              <EChart option={option} height={CHART_HEIGHT} ariaLabel="Отправлено, не доставлено, ответы и лиды по дням" />
            ) : (
              <div style={{ height: CHART_HEIGHT }} />
            )}
          </div>

          {data.notes.map((note) => (
            <p key={note} className="text-[11px] text-zinc-400">{note}</p>
          ))}
        </>
      )}
    </div>
  );
}
