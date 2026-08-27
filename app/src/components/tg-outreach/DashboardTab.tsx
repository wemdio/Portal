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
import BasesTable from '@/components/tg-outreach/BasesTable';
import type { BaseStats } from '@/lib/tgOutreach/baseStats';
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

interface DashboardApiResponse {
  period: DashboardPeriod;
  /** Сколько аккаунтов реально отправляли первые сообщения за сутки. */
  sending: number;
  dashboard: CampaignDashboard;
  accounts: AccountsSummary;
  accounts_total: number;
  warming: number;
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

/** «2 ч 15 мин» из минут. Прочерк — когда мерить нечего. */
function formatMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 24) return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} дн ${restHours} ч` : `${days} дн`;
}

/**
 * Плашка сигнала рядом с воронкой. Цветная — только когда есть о чём тревожиться:
 * ноль в красной рамке читается как авария, которой нет.
 */
function SignalTile({
  label,
  value,
  caption,
  hint,
  alarming = false,
  amber = false,
}: {
  label: string;
  value: string | number;
  caption: string;
  /** Подсказка при наведении: что именно считается и чего в цифре нет. */
  hint: string;
  alarming?: boolean;
  /** Жёлтый вместо красного — для «есть работа», а не «что-то сломалось». */
  amber?: boolean;
}) {
  const tone = !alarming
    ? { box: 'border-gray-200 bg-white', label: 'text-gray-500', value: 'text-gray-800', cap: 'text-gray-400' }
    : amber
      ? { box: 'border-amber-200 bg-amber-50', label: 'text-amber-600', value: 'text-amber-700', cap: 'text-amber-600' }
      : { box: 'border-rose-200 bg-rose-50', label: 'text-rose-600', value: 'text-rose-700', cap: 'text-rose-500' };

  return (
    <div className={`flex flex-col gap-1 rounded-xl border p-4 ${tone.box}`}>
      <span className={`text-xs font-medium ${tone.label}`}>{label}</span>
      <span className={`text-2xl font-semibold ${tone.value}`}>{value}</span>
      <span title={hint} className={`cursor-help text-[10px] leading-snug ${tone.cap}`}>
        {caption}
      </span>
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
  /**
   * Цифры по базам. Отдельным запросом, а не полем сводки: их же показывает
   * сравнение гипотез на вкладке «Базы», и считать их надо одинаково — общая
   * ручка гарантирует, что два экрана не разойдутся в числах.
   */
  const [bases, setBases] = useState<BaseStats[]>([]);
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
        const [res, basesRes] = await Promise.all([
          authFetch(`${API_BASE}/campaigns/${campaignId}/dashboard?${qs}`),
          authFetch(`${API_BASE}/campaigns/${campaignId}/bases-stats?${qs}`),
        ]);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Не удалось загрузить сводку (${res.status})`);
          return;
        }
        setData((await res.json()) as DashboardApiResponse);
        // Цифры по базам — дополнение к сводке: если они не пришли, показываем
        // сводку без них, а не пустой экран с ошибкой.
        if (basesRes.ok) {
          const body = (await basesRes.json()) as { bases: BaseStats[] };
          setBases(body.bases ?? []);
        } else {
          setBases([]);
        }
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

  /**
   * За какой период посчитано «Среднесуточно».
   *
   * Цифру читали как «за всё время» и не понимали, почему она меняется при
   * переключении вкладок наверху. Считается она по выбранному периоду —
   * поэтому период и подписан. Делим при этом на ПРОШЕДШИЕ сутки, а не на
   * номинальную длину окна: у кампании, живущей три дня, «за 30 дней»
   * занизило бы темп в десять раз.
   */
  const paceCaption = useMemo(() => {
    if (custom) return `за период ${custom.from} — ${custom.to}`;
    const label = PERIOD_OPTIONS.find((o) => o.id === period)?.label ?? '';
    return period === 'all' ? 'за всё время' : `за ${label.toLowerCase()}`;
  }, [period, custom]);

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
          {/* Воронка отдельной строкой, сигналы — своей. Раньше блокировки
              жались узкой колонкой сбоку; впятером они бы там не поместились,
              а главное — это однородный ряд, и читать его удобнее в строку. */}
          <DashboardFunnel funnel={data.dashboard.funnel} />

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <SignalTile
              label="Заблокировали нас"
              value={data.dashboard.blocks}
              alarming={data.dashboard.blocks > 0}
              caption="закрыли доступ аккаунту, с которого писали. Растёт — снижайте темп"
              hint={
                'Диалоги, где Telegram отказал в отправке с кодом «пользователь заблокировал». '
                + 'Узнаём об этом только при следующей попытке написать, поэтому число заведомо неполное: '
                + 'кто заблокировал после последней реплики цепочки, сюда не попадёт.'
              }
            />
            <SignalTile
              label="Недоступны"
              value={data.dashboard.unreachable}
              alarming={data.dashboard.unreachable > 0}
              caption="удалённые аккаунты и прочие мёртвые контакты"
              hint={
                'Удалённый аккаунт, невалидный peer, бан в канале и прочая недоступность. '
                + 'Блокировки сюда НЕ входят — у них своя цифра слева, иначе один человек считался бы дважды. '
                + 'Высокая доля обычно значит, что база старая или собрана некачественно.'
              }
            />
            <SignalTile
              label="Ждут ответа"
              value={data.dashboard.awaiting}
              caption="написали в этот период и пока молчат"
              hint={
                'Диалоги, где наше первое сообщение попало в период, а ответа нет до сих пор — '
                + 'даже если он придёт позже конца периода. Это размер «висящего» пула: '
                + 'из него ещё могут прийти ответы, и он же показывает, сколько касаний ушло впустую.'
              }
            />
            <SignalTile
              label="Требуют внимания"
              value={data.dashboard.needsAttention}
              alarming={data.dashboard.needsAttention > 0}
              amber
              caption="ответили, но статус не проставлен и менеджеру не передали"
              hint={
                'Очередь работы оператора: человек ответил в этом периоде, но диалог до сих пор без статуса '
                + '(не «Целевой», не «Не целевой», не «Позже») и менеджеру не передан. '
                + 'Сорвавшиеся передачи внимание не снимают — до менеджера такой диалог не дошёл.'
              }
            />
            <SignalTile
              label="Отвечают за"
              value={formatMinutes(data.dashboard.avgReplyMinutes)}
              caption="в среднем от нашего сообщения до ответа"
              hint={
                'Среднее по тем, кто ответил в этом периоде: от НАШЕГО последнего сообщения до его ответа. '
                + 'От последнего, а не от первого касания — человек отвечает на то, что прочитал сейчас, '
                + 'иначе получилась бы длительность всей цепочки. Прочерк значит, что в периоде никто не ответил.'
              }
            />
          </div>

          <DailyActivityChart days={data.dashboard.days} />

          {/* Здоровье кампании */}
          <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-gray-800">Здоровье кампании</h3>

            <div className="text-[11px] font-medium text-gray-400">Аккаунты</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              {/* Первым — то, ради чего экран открывают: сколько аккаунтов
                  реально пишут людям. «Живы» и «Выключены» отвечают только на
                  вопрос о разрешениях: аккаунт бывает живым, включённым и при
                  этом молчащим вторые сутки. */}
              <Metric
                label="Рассылают"
                value={data.sending}
                tone={data.sending > 0 ? 'info' : 'danger'}
                caption={`из ${data.accounts_total} за сутки`}
              />
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
              {/* Без подписи цифру читали как «за всё время», хотя считается
                  она по выбранному наверху периоду — и от переключения вкладок
                  менялась без объяснения. */}
              <Metric
                label="Среднесуточно"
                value={data.dashboard.pace.perDay}
                caption={paceCaption}
              />
            </div>

            {/* Раньше здесь стояли два числа по всем базам разом — «осталось
                контактов 320». На вопрос «это одна база или пять, и какая из
                них заканчивается» они не отвечали вовсе. Теперь строка на
                базу: видно, сколько гипотез в работе и какая выдохлась. */}
            <div className="text-[11px] font-medium text-gray-400">
              Базы <span className="text-gray-300">({bases.length})</span>
            </div>
            {bases.length === 0 ? (
              <div className="rounded-xl bg-gray-50 px-3 py-3 text-xs text-gray-400">
                В кампании нет ни одной базы контактов.
              </div>
            ) : (
              <BasesTable bases={bases} />
            )}
          </div>

        </>
      ) : null}
    </div>
  );
}
