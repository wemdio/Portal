'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

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
import { authFetch } from '@/lib/authFetch';
import type { BaseStats } from '@/lib/tgOutreach/baseStats';

/**
 * Сравнение двух гипотез.
 *
 * Смысл вкладки «Базы» — понять, какая гипотеза работает лучше, но сравнивать
 * было нечем: список показывал только счётчики состояний контактов, а сводка
 * складывала все базы в одну кучу. Оператор считал в голове или в Excel.
 *
 * Две колонки, а не одна таблица со строками: сравнивают попарно и глазами, и
 * рядом стоящие числа читаются быстрее, чем строки, разнесённые по вертикали.
 * Разница проговаривается словами — «на 12 % лучше» полезнее, чем два числа,
 * между которыми читатель должен посчитать сам.
 *
 * Графики намеренно на одной сетке суток и с общей осью: расчёт отдаёт обеим
 * базам одинаковый ряд дней (см. baseStats.ts), иначе линии разъезжаются и
 * сравнение превращается в оптический обман.
 */

const METRIC_LABELS = ['Отправлено', 'Ответы', 'Лиды', 'Блокировки'] as const;

function buildOption(
  a: BaseStats,
  b: BaseStats,
  metric: number,
  theme: ChartTheme,
  animate: boolean,
): EChartsCoreOption {
  const key = (['sent', 'replies', 'leads', 'blocks'] as const)[metric];
  const dates = a.days.map((d) =>
    new Date(d.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
  );

  const line = (stats: BaseStats, index: number) => ({
    name: stats.name,
    type: 'line' as const,
    smooth: true,
    symbol: 'circle',
    symbolSize: 5,
    lineStyle: { width: 2, color: seriesColor(theme, index) },
    itemStyle: { color: seriesColor(theme, index) },
    data: stats.days.map((d) => d[key]),
  });

  return {
    animation: animate,
    animationDuration: 600,
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
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: GRID_LINE } },
      axisLabel: { color: AXIS_TEXT, fontSize: AXIS_FONT_SIZE, fontFamily: CHART_FONT },
    },
    series: [line(a, 0), line(b, 1)],
  };
}

/**
 * Разница между базами словами: «+38 %», «−12 %», «одинаково».
 *
 * Процент — от ПРАВОЙ базы: она читается как «с чем сравниваем». Деление на
 * ноль разводим отдельными фразами, потому что «+∞ %» ничего не сообщает, а
 * «только у первой» — сообщает.
 *
 * `lowerIsBetter` переворачивает цвет, но не знак: у блокировок рост — это
 * плохо, и красить его зелёным только потому, что число больше, значило бы
 * подсказать оператору ровно наоборот.
 */
function diffLabel(
  left: number,
  right: number,
  lowerIsBetter = false,
): { text: string; tone: string } {
  const good = 'text-emerald-600';
  const bad = 'text-rose-600';
  const better = lowerIsBetter ? bad : good;
  const worse = lowerIsBetter ? good : bad;

  if (left === right) return { text: 'одинаково', tone: 'text-gray-400' };
  if (right === 0) return { text: 'только у первой', tone: better };
  if (left === 0) return { text: 'только у второй', tone: worse };

  const pct = Math.round(((left - right) / right) * 100);
  return {
    text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`,
    tone: pct > 0 ? better : worse,
  };
}

function Row({
  label,
  left,
  right,
  hint,
  /** Для блокировок «больше» — это хуже, и цвет разницы надо перевернуть. */
  lowerIsBetter,
}: {
  label: string;
  left: number;
  right: number;
  hint?: string;
  lowerIsBetter?: boolean;
}) {
  const diff = diffLabel(left, right, lowerIsBetter);
  return (
    <tr className="border-t border-gray-100">
      <td className="px-2 py-1.5 text-xs text-gray-500" title={hint}>{label}</td>
      <td className="px-2 py-1.5 text-right text-xs font-medium text-gray-900 tabular-nums">{left}</td>
      <td className="px-2 py-1.5 text-right text-xs font-medium text-gray-900 tabular-nums">{right}</td>
      <td className={`px-2 py-1.5 text-right text-[11px] tabular-nums ${diff.tone}`}>{diff.text}</td>
    </tr>
  );
}

export default function BaseComparison({
  campaignId,
  bases,
}: {
  campaignId: string;
  /** Список баз кампании — только для выбора; цифры приходят отдельным запросом. */
  bases: Array<{ id: string; name: string }>;
}) {
  /**
   * Что выбрал оператор. Пусто — он ещё не выбирал, и тогда берём первые две
   * базы: пустые селекты требуют двух кликов, прежде чем экран вообще
   * что-нибудь покажет.
   *
   * Умолчание выводим при чтении, а не досылаем эффектом в состояние. Эффект
   * ради подстановки значения — это лишний круг перерисовки и целый класс
   * ошибок «список пришёл позже, чем эффект успел отработать».
   */
  const [leftPick, setLeftId] = useState<string>('');
  const [rightPick, setRightId] = useState<string>('');
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('30d');
  const [stats, setStats] = useState<BaseStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme(rootRef);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await authFetch(
          `/api/tools/tg-outreach/campaigns/${campaignId}/bases-stats?period=${period}`,
        );
        if (res.ok) {
          const body = (await res.json()) as { bases: BaseStats[] };
          setStats(body.bases ?? []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [campaignId, period]);

  const leftId = leftPick || bases[0]?.id || '';
  const rightId = rightPick || bases[1]?.id || '';

  const left = useMemo(() => stats.find((s) => s.baseId === leftId), [stats, leftId]);
  const right = useMemo(() => stats.find((s) => s.baseId === rightId), [stats, rightId]);

  const option = useMemo(
    () => (theme && left && right ? buildOption(left, right, metric, theme, !reducedMotion) : null),
    [theme, left, right, metric, reducedMotion],
  );

  if (bases.length < 2) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-xs text-gray-400">
        Сравнивать пока не с чем: в кампании должно быть хотя бы две базы.
      </div>
    );
  }

  const selectCls =
    'rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 cursor-pointer';

  return (
    <div ref={rootRef} className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-800">Сравнение баз</h3>
        <div className="ml-auto flex items-center gap-1.5">
          {(['7d', '30d', 'all'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer border ${period === p ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}
            >
              {p === '7d' ? '7 дней' : p === '30d' ? '30 дней' : 'Всё время'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={leftId} onChange={(e) => setLeftId(e.target.value)} className={selectCls}>
          {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <span className="text-xs text-gray-400">против</span>
        <select value={rightId} onChange={(e) => setRightId(e.target.value)} className={selectCls}>
          {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {loading && !left ? (
        <div className="py-8 text-center text-xs text-gray-400">Считаю…</div>
      ) : !left || !right ? (
        <div className="py-8 text-center text-xs text-gray-400">Выберите две базы.</div>
      ) : leftId === rightId ? (
        <div className="py-8 text-center text-xs text-gray-400">
          Выбрана одна и та же база — сравнивать её не с чем.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-gray-50">
            <table className="min-w-full border-collapse">
              <thead>
                <tr>
                  <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-400">Показатель</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-400">{left.name}</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-400">{right.name}</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-400">Разница</th>
                </tr>
              </thead>
              <tbody>
                <Row label="Контактов всего" left={left.total} right={right.total} />
                <Row label="Отправлено" left={left.sent} right={right.sent} hint="Первых сообщений за выбранный период" />
                <Row label="Ответы" left={left.replies} right={right.replies} />
                <Row label="Лиды" left={left.leads} right={right.leads} />
                <Row label="Переданы менеджеру" left={left.forwarded} right={right.forwarded} hint="И автоматом по триггеру, и вручную" />
                <Row label="Блокировки" left={left.blocks} right={right.blocks} hint="Человек прочитал и закрыл доступ" lowerIsBetter />
                <Row label="Осталось контактов" left={left.remaining} right={right.remaining} />
                <Row label="Аккаунтов рассылало" left={left.accountIds.length} right={right.accountIds.length} hint="Сколько разных аккаунтов отправляли по этой базе за период" />
              </tbody>
            </table>
          </div>

          {/* Конверсии отдельно от счётчиков: они сравнивают базы разного
              размера, и складывать их в один столбец с абсолютными числами
              значит приглашать читать проценты как штуки. */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[left, right].map((s) => (
              <div key={s.baseId} className="rounded-xl bg-gray-50 px-3 py-2">
                <div className="truncate text-[11px] font-medium text-gray-700">{s.name}</div>
                <div className="mt-1 text-gray-500">
                  ответов {s.replyRate === null ? '—' : `${s.replyRate}%`} от отправленных
                  {' · '}
                  лидов {s.leadRate === null ? '—' : `${s.leadRate}%`} от ответивших
                </div>
                <div className="text-gray-400">
                  темп {s.perDay}/день · {s.remaining === 0
                    ? 'база кончилась'
                    : s.daysLeft === null ? 'остатка хватит — темп нулевой' : `хватит на ${s.daysLeft} дн.`}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-400">Динамика:</span>
            {METRIC_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => setMetric(i)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer border ${metric === i ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {option ? (
            <EChart
              option={option}
              height={260}
              ariaLabel={`Динамика по дням: ${METRIC_LABELS[metric]} — ${left.name} и ${right.name}`}
            />
          ) : (
            <div style={{ height: 260 }} />
          )}
        </>
      )}
    </div>
  );
}
