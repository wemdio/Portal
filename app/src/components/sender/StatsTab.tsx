'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import EChart from '@/components/charts/EChart';
import { DomainDeliverability } from './DomainDeliverability';
import { BounceCodes } from './BounceCodes';
import type { BounceKinds } from '@/lib/sender/domainReputation';
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
  verticalGradient,
  type ChartTheme,
} from '@/components/charts/theme';
import {
  fetchCampaigns,
  fetchSenderStats,
  type CampaignDto,
  type SenderStatCounters,
  type SenderStatsDto,
  type SenderStatsPeriod,
  type SenderStatsScope,
} from './api';

/**
 * Вкладка «Статистика»: ответы, доставляемость и лиды «Рассылки» за период.
 * Раньше это была кнопка «Статистика ответов» в шапке списка ящиков, и её
 * не могли найти три дня.
 *
 * Все числа считает sender_stats_dashboard; здесь только раскладка. Доли —
 * по когорте (получатели, которым первое письмо ушло в периоде), график — по
 * событиям дня. Подсказки у плиток это проговаривают.
 */

const PERIODS: { id: SenderStatsPeriod; label: string }[] = [
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
  { id: '90d', label: '90 дней' },
  { id: 'all', label: 'Всё время' },
];

/**
 * Пороги отбоев. До 2% — норма для холодной базы; выше 5% почтовики начинают
 * резать репутацию домена, и монитор «Рассылки» ставит домен на паузу.
 */
const BOUNCE_WARN = 2;
const BOUNCE_BAD = 5;

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString('ru-RU')}%`;
}

function bounceTone(value: number | null): 'bad' | 'warn' | null {
  if (value === null) return null;
  if (value > BOUNCE_BAD) return 'bad';
  if (value > BOUNCE_WARN) return 'warn';
  return null;
}

function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} мин`;
  if (hours < 48) return `${Math.round(hours)} ч`;
  return `${Math.round(hours / 24)} дн`;
}

function formatDay(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

const nf = (value: number) => value.toLocaleString('ru-RU');

// ─── Плитки ────────────────────────────────────────────────────────────────

function Tile({
  label,
  value,
  caption,
  hint,
  tone,
}: {
  label: string;
  value: string;
  caption: string;
  hint: string;
  tone?: 'good' | 'warn' | 'bad' | null;
}) {
  const box = tone === 'bad'
    ? 'border-red-200 bg-red-50'
    : tone === 'warn'
      ? 'border-amber-200 bg-amber-50'
      : 'border-zinc-200 bg-white';
  const valueCls = tone === 'bad'
    ? 'text-red-700'
    : tone === 'warn'
      ? 'text-amber-700'
      : tone === 'good'
        ? 'text-emerald-700'
        : 'text-zinc-900';
  return (
    <div title={hint} className={`flex cursor-help flex-col gap-1 rounded-xl border p-4 ${box}`}>
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${valueCls}`}>{value}</span>
      <span className="text-xs leading-snug text-zinc-400">{caption}</span>
    </div>
  );
}

// ─── График по дням ─────────────────────────────────────────────────────────

function buildDailyOption(days: SenderStatsDto['days'], theme: ChartTheme, animate: boolean): EChartsCoreOption {
  const labels = days.map((d) => formatDay(d.day));
  const colors = [0, 1, 2, 3].map((slot) => seriesColor(theme, slot));
  const line = (name: string, values: number[], slot: number, dashed = false) => ({
    name,
    type: 'line' as const,
    yAxisIndex: 1,
    data: values,
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    lineStyle: { width: 2.5, color: colors[slot], type: (dashed ? 'dashed' : 'solid') as 'dashed' | 'solid' },
    itemStyle: { color: colors[slot], borderColor: theme.surface, borderWidth: 1.5 },
  });
  const axisLabel = { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT };

  return {
    animation: animate,
    animationDuration: 700,
    textStyle: { fontFamily: CHART_FONT },
    grid: { left: 4, right: 4, top: 44, bottom: 4, containLabel: true },
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
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel,
    },
    // Две оси: писем уходят сотни, ответов — единицы, и на общей шкале линии
    // ответов лежали бы на нуле. Левая — письма; у линий свой масштаб без
    // подписей (шкала «люди» сбивала с толку), числа — в подсказке.
    yAxis: [
      { type: 'value', name: 'письма', minInterval: 1, nameTextStyle: axisLabel, splitLine: { lineStyle: { color: GRID_LINE } }, axisLabel },
      { type: 'value', minInterval: 1, splitLine: { show: false }, axisLabel: { show: false } },
    ],
    series: [
      {
        name: 'Отправлено писем',
        type: 'bar',
        yAxisIndex: 0,
        data: days.map((d) => d.sent),
        barMaxWidth: 28,
        itemStyle: { color: verticalGradient(colors[0], 0.35), borderRadius: [4, 4, 0, 0] },
      },
      line('Ответили', days.map((d) => d.replied), 2),
      line('Лиды', days.map((d) => d.leads), 3),
      // Отбои пунктиром: это не ещё один объём, а сигнал тревоги.
      line('Отбои', days.map((d) => d.bounced), 1, true),
    ],
  };
}

function DailyChart({ days }: { days: SenderStatsDto['days'] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();
  const option = useMemo(
    () => (theme ? buildDailyOption(days, theme, !reducedMotion) : null),
    [days, theme, reducedMotion],
  );
  const empty = days.every((d) => !d.sent && !d.replied && !d.bounced && !d.leads);

  return (
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-zinc-900">По дням</h3>
      <p className="mb-2 text-xs text-zinc-400">Что произошло в каждый день: ушло писем, ответили, отбились, стали лидами</p>
      {empty ? (
        <p className="py-16 text-center text-sm text-zinc-400">За этот период писем не отправлялось.</p>
      ) : option ? (
        <EChart option={option} height={280} ariaLabel="По дням: отправлено писем, ответили, лиды, отбои" />
      ) : (
        <div style={{ height: 280 }} />
      )}
    </div>
  );
}

// ─── Воронка ────────────────────────────────────────────────────────────────

function Funnel({ totals }: { totals: SenderStatsDto['totals'] }) {
  const stages = [
    { label: 'Получили письмо', value: totals.reached, color: 'var(--chart-series-1)' },
    { label: 'Ответили', value: totals.replied, color: 'var(--chart-series-3)' },
    { label: 'Лиды', value: totals.leads, color: 'var(--chart-series-4)' },
  ];
  const top = Math.max(1, totals.reached);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-zinc-900">Воронка</h3>
      <p className="mb-4 text-xs text-zinc-400">Люди, которым первое письмо ушло в этом периоде</p>
      <div className="space-y-3">
        {stages.map((stage, index) => {
          const prev = index > 0 ? stages[index - 1].value : null;
          return (
            <div key={stage.label}>
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span className="text-zinc-600">{stage.label}</span>
                <span className="tabular-nums">
                  <span className="font-semibold text-zinc-900">{nf(stage.value)}</span>
                  {prev !== null ? (
                    <span className="ml-2 text-xs text-zinc-400">{formatRate(rate(stage.value, prev))} от прошлого шага</span>
                  ) : null}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${stage.value ? Math.max(1.5, (stage.value / top) * 100) : 0}%`,
                    background: stage.color,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-zinc-400">
        Ещё в цепочке: {nf(totals.in_progress)} — им уйдут следующие письма, и ответы от них ещё могут прийти.
      </p>
    </div>
  );
}

// ─── Доставляемость ─────────────────────────────────────────────────────────

const SUPPRESS_LABELS: Record<string, string> = {
  hard_bounce: 'адрес не существует',
  unsubscribe: 'отписались',
  complaint: 'жалобы на спам',
  manual: 'добавлены руками',
};

const INBOX_LABELS: Record<string, string> = {
  human: 'живые ответы',
  auto_reply: 'автоответы',
  bounce: 'отбойники',
  unknown: 'не распознаны',
};

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' | null }) {
  const cls = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-zinc-900';
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className={`font-medium tabular-nums ${cls}`}>{value}</span>
    </div>
  );
}

function Deliverability({ data }: { data: SenderStatsDto }) {
  const bounce = rate(data.totals.bounced, data.totals.reached);
  const attempts = data.letters.sent + data.letters.failed;
  const failRate = rate(data.letters.failed, attempts);
  const inbox = Object.entries(data.inbox).sort((a, b) => b[1] - a[1]);
  const suppressed = Object.entries(data.suppressed).sort((a, b) => b[1] - a[1]);
  const barWidth = bounce === null ? 0 : Math.min(100, (bounce / (BOUNCE_BAD * 2)) * 100);
  const tone = bounceTone(bounce);
  const kinds: BounceKinds = data.bounceKinds ?? {};

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-zinc-900">Доставляемость</h3>
      <p className="mb-4 text-xs text-zinc-400">Доходят ли письма и в каком состоянии ящики</p>

      {/* Шкала отбоев с порогами: число само по себе ничего не говорит, пока
          не видно, где кончается норма. */}
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-zinc-600">Отбои</span>
        <span className={`font-semibold tabular-nums ${tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-emerald-600'}`}>
          {formatRate(bounce)}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-gradient-to-r from-emerald-200 via-amber-200 to-red-200">
        <div
          className="absolute -top-1 w-1 rounded-full bg-zinc-800"
          style={{ left: `calc(${barWidth}% - 2px)`, height: 18 }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-zinc-400">
        <span>0%</span>
        <span>норма до {BOUNCE_WARN}%</span>
        <span>опасно от {BOUNCE_BAD}%</span>
        <span>{BOUNCE_BAD * 2}%+</span>
      </div>

      <div className="mt-4 divide-y divide-zinc-100">
        <Row
          label="Отклонили как спам"
          value={nf(kinds.spam ?? 0)}
          tone={kinds.spam ? 'bad' : null}
        />
        <Row
          label="Не прошли проверку подписи домена"
          value={nf(kinds.auth ?? 0)}
          tone={kinds.auth ? 'warn' : null}
        />
        <Row label="Адреса нет" value={nf(kinds.no_user ?? 0)} />
        <Row label="Временно не доставлены" value={nf(kinds.temporary ?? 0)} />
        <Row
          label="Не отправились (ошибка SMTP)"
          value={data.letters.failed ? `${nf(data.letters.failed)} · ${formatRate(failRate)}` : '0'}
          tone={data.letters.failed ? 'warn' : null}
        />
        <Row
          label="Ящиков в рассылке"
          value={`${nf(data.mailboxes.enabled)} из ${nf(data.mailboxes.total)}`}
        />
        <Row
          label="С ошибкой входа"
          value={nf(data.mailboxes.failed)}
          tone={data.mailboxes.failed ? 'bad' : null}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-400">Входящие</div>
          {inbox.length ? inbox.map(([kind, n]) => (
            <div key={kind} className="flex justify-between text-xs text-zinc-600">
              <span>{INBOX_LABELS[kind] ?? kind}</span>
              <span className="tabular-nums">{nf(n)}</span>
            </div>
          )) : <div className="text-xs text-zinc-400">нет</div>}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-400">В стоп-лист</div>
          {suppressed.length ? suppressed.map(([reason, n]) => (
            <div key={reason} className="flex justify-between text-xs text-zinc-600">
              <span>{SUPPRESS_LABELS[reason] ?? reason}</span>
              <span className="tabular-nums">{nf(n)}</span>
            </div>
          )) : <div className="text-xs text-zinc-400">никого</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Шаги цепочки ───────────────────────────────────────────────────────────

function Steps({ steps }: { steps: SenderStatsDto['steps'] }) {
  const totalReplies = steps.reduce((sum, s) => sum + s.replied, 0);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-zinc-900">На какое письмо отвечают</h3>
      <p className="mb-4 text-xs text-zinc-400">Шаг цепочки, после которого человек ответил</p>
      {steps.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">Писем в этом периоде не было.</p>
      ) : (
        <div className="space-y-3">
          {steps.map((s) => {
            const share = totalReplies ? (s.replied / totalReplies) * 100 : 0;
            return (
              <div key={s.step}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-zinc-600">Письмо {s.step}</span>
                  <span className="tabular-nums text-xs text-zinc-400">
                    <span className="text-sm font-semibold text-zinc-900">{nf(s.replied)}</span>
                    {' '}ответов из {nf(s.reached)} · {formatRate(rate(s.replied, s.reached))}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${s.replied ? Math.max(1.5, share) : 0}%`, background: 'var(--chart-series-3)' }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Разрезы: кампании / домены / ящики ─────────────────────────────────────

// Домены — отдельной таблицей с репутацией (DomainDeliverability).
type Breakdown = 'campaigns' | 'mailboxes';
type SortKey = 'sent' | 'reached' | 'replyRate' | 'leads' | 'bounceRate';

type TableRow = SenderStatCounters & { key: string; name: string; note?: string; sent: number };

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'sent', label: 'Писем' },
  { key: 'reached', label: 'Получателей' },
  { key: 'replyRate', label: 'Ответили' },
  { key: 'leads', label: 'Лиды' },
  { key: 'bounceRate', label: 'Отбои' },
];

function sortValue(row: TableRow, key: SortKey): number {
  if (key === 'replyRate') return rate(row.replied, row.reached) ?? -1;
  if (key === 'bounceRate') return rate(row.bounced, row.reached) ?? -1;
  return row[key];
}

function BreakdownTable({ data }: { data: SenderStatsDto }) {
  const [view, setView] = useState<Breakdown>('campaigns');
  const [sort, setSort] = useState<SortKey>('sent');

  const rows: TableRow[] = useMemo(() => {
    const base: TableRow[] = view === 'campaigns'
      ? data.campaigns.map((c) => ({
        ...c, key: c.id, name: c.name, note: c.status === 'running' ? undefined : c.status === 'paused' ? 'на паузе' : c.status === 'done' ? 'завершена' : 'черновик',
      }))
      : data.mailboxList.map((m) => ({
        ...m, key: m.id, name: m.email, note: !m.enabled ? 'выключен' : m.status === 'failed' ? 'ошибка входа' : undefined,
      }));
    return [...base].sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  }, [data, view, sort]);

  const tabs: { id: Breakdown; label: string }[] = [
    { id: 'campaigns', label: `Кампании (${data.campaigns.length})` },
    { id: 'mailboxes', label: `Ящики (${data.mailboxList.length})` },
  ];

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-900">Где работает, а где нет</h3>
        <div className="inline-flex gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setView(t.id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                view === t.id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-zinc-400">За этот период писем не отправлялось.</p>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs uppercase text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="px-5 py-2 font-medium">
                  {view === 'campaigns' ? 'Кампания' : 'Ящик'}
                </th>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="px-3 py-2 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => setSort(col.key)}
                      className={`uppercase hover:text-zinc-800 ${sort === col.key ? 'text-blue-600' : ''}`}
                      title="Сортировать по убыванию"
                    >
                      {col.label}{sort === col.key ? ' ↓' : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const reply = rate(row.replied, row.reached);
                const bounce = rate(row.bounced, row.reached);
                const tone = bounceTone(bounce);
                return (
                  <tr key={row.key} className="border-b border-zinc-100 last:border-0">
                    <td className="px-5 py-2">
                      <span className="font-medium text-zinc-900">{row.name}</span>
                      {row.note ? <span className="ml-2 text-xs text-zinc-400">{row.note}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{nf(row.sent)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{nf(row.reached)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="text-emerald-700">{formatRate(reply)}</span>
                      <span className="ml-1 text-xs text-zinc-400">{row.replied ? `(${nf(row.replied)})` : ''}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{nf(row.leads)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${
                      tone === 'bad' ? 'font-medium text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-zinc-600'
                    }`}>
                      {formatRate(bounce)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Вкладка ────────────────────────────────────────────────────────────────

const SCOPES: { id: SenderStatsScope; label: string; hint: string }[] = [
  { id: 'ours', label: 'Письма Рассылки', hint: 'Ответы и отказы только по письмам кампаний Рассылки' },
  { id: 'all', label: 'Все на наших ящиках', hint: 'Плюс ответы и отказы на письма других инструментов с этих же ящиков' },
];

/** initialCampaignId — кампания, из строки которой нажали «Статистика». */
export function StatsTab({ initialCampaignId = null }: { initialCampaignId?: string | null } = {}) {
  const [period, setPeriod] = useState<SenderStatsPeriod>('30d');
  // null — все кампании сразу.
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId);
  const [campaignList, setCampaignList] = useState<Pick<CampaignDto, 'id' | 'name'>[]>([]);
  // ours — входящие и отказы только по письмам «Рассылки»: наши ящики шлют и
  // другие инструменты, их отбойники иначе портят доставляемость.
  const [scope, setScope] = useState<SenderStatsScope>('ours');
  const [data, setData] = useState<SenderStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Кнопка «Обновить» перезапускает тот же эффект, что и смена периода.
  const [reloadKey, setReloadKey] = useState(0);

  // Список для выбора — все кампании, а не только с письмами в периоде:
  // иначе выбранная кампания пропадала бы из списка при смене периода.
  useEffect(() => {
    let cancelled = false;
    fetchCampaigns()
      .then((res) => {
        if (!cancelled) setCampaignList(res.campaigns.map(({ id, name }) => ({ id, name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchSenderStats(period, campaignId, scope);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить статистику');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period, campaignId, scope, reloadKey]);

  const t = data?.totals;
  const replyRate = t ? rate(t.replied, t.reached) : null;
  const bounceRate = t ? rate(t.bounced, t.reached) : null;
  const unsubRate = t ? rate(t.unsubscribed, t.reached) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex gap-1 rounded-xl border border-zinc-200 bg-white p-1">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={loading}
                onClick={() => setPeriod(p.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 ${
                  period === p.id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <select
            value={campaignId ?? ''}
            onChange={(e) => setCampaignId(e.target.value || null)}
            disabled={loading}
            aria-label="Кампания"
            className="max-w-xs rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
          >
            <option value="">Все кампании</option>
            {campaignList.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {/* С выбранной кампанией всё и так только её — переключать нечего. */}
          {campaignId === null && (
            <div className="inline-flex gap-1 rounded-xl border border-zinc-200 bg-white p-1" role="group" aria-label="Чьи письма считать">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={loading}
                  onClick={() => setScope(s.id)}
                  title={s.hint}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 ${
                    scope === s.id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {!data || !t ? (
        loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Считаю статистику…
          </div>
        ) : null
      ) : (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-50' : ''}`}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile
              label="Отправлено писем"
              value={nf(data.letters.sent)}
              caption={`получателей: ${nf(t.reached)}`}
              hint="Все письма цепочек, ушедшие за период, включая повторные касания. Получатели — люди, которым первое письмо ушло в этом периоде."
            />
            <Tile
              label="Ответили"
              value={formatRate(replyRate)}
              caption={`${nf(t.replied)} из ${nf(t.reached)} получателей`}
              tone={t.replied ? 'good' : null}
              hint="Доля людей, ответивших живым письмом (автоответы и отбойники не считаются). Берутся получатели, которым первое письмо ушло в периоде, — даже если ответили они позже."
            />
            <Tile
              label="Лиды"
              value={nf(t.leads)}
              caption={t.replied ? `${formatRate(rate(t.leads, t.replied))} от ответивших` : 'ответов пока нет'}
              tone={t.leads ? 'good' : null}
              hint="Ответившие, которых ИИ-квалификатор или человек отметил как лида (вкладка «Квалификация» автоаутрича)."
            />
            <Tile
              label="Отбои"
              value={formatRate(bounceRate)}
              caption={t.bounced ? `не дошло до ${nf(t.bounced)} человек` : 'все письма дошли'}
              tone={bounceTone(bounceRate)}
              hint={`Адрес не существует или сервер получателя отказал. До ${BOUNCE_WARN}% — норма для холодной базы; выше ${BOUNCE_BAD}% страдает репутация домена, и монитор ставит его на паузу.`}
            />
            <Tile
              label="Отписались"
              value={formatRate(unsubRate)}
              caption={`${nf(t.unsubscribed)} человек`}
              tone={unsubRate !== null && unsubRate > 2 ? 'warn' : null}
              hint="Попросили больше не писать. Высокая доля — повод пересмотреть текст или базу."
            />
            <Tile
              label="Отвечают через"
              value={formatHours(t.median_reply_hours)}
              caption="от первого письма, медиана"
              hint="Половина ответивших ответила быстрее этого срока, половина — дольше. Помогает понять, когда ответов от свежей рассылки ждать уже не стоит."
            />
          </div>

          <DailyChart days={data.days} />

          <div className="grid gap-4 lg:grid-cols-3">
            <Funnel totals={t} />
            <Deliverability data={data} />
            <Steps steps={data.steps} />
          </div>

          <DomainDeliverability domains={data.domains} />

          <BounceCodes period={period} campaignId={campaignId} scope={scope} reloadKey={reloadKey} />

          <BreakdownTable data={data} />
        </div>
      )}
    </div>
  );
}
