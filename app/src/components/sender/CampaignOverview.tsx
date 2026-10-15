'use client';

import type { Route } from 'next';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Pause, Play, Settings } from 'lucide-react';
import {
  fetchCampaign,
  fetchSenderStats,
  patchCampaign,
  type CampaignDetailsDto,
  type SenderStatsDto,
  type SenderStatsPeriod,
} from './api';
import { DailyChart } from './StatsTab';

/**
 * Страница кампании — статистика, как «Analytics» в Instantly: плитки, график
 * по дням и разбивка по шагам и вариантам писем. Настройки (письма, база,
 * ящики, расписание) — за шестерёнкой, на отдельной странице.
 *
 * Открытий и кликов нет: пиксель открытий в «Рассылке» не ставим намеренно —
 * он бьёт по доставляемости. Вместо Opportunities — наши «Лиды».
 */

const PERIODS: Array<{ id: SenderStatsPeriod; label: string }> = [
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
  { id: '90d', label: '90 дней' },
  { id: 'all', label: 'Всё время' },
];

const STATUS_PILL: Record<CampaignDetailsDto['campaign']['status'], { text: string; pill: string; dot: string }> = {
  draft: { text: 'Черновик', pill: 'bg-zinc-100 text-zinc-600', dot: 'bg-zinc-400' },
  running: { text: 'Идёт', pill: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  paused: { text: 'Пауза', pill: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  done: { text: 'Завершена', pill: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
};

const nf = (value: number) => value.toLocaleString('ru-RU');

function percent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${(Math.round((part / whole) * 1000) / 10).toLocaleString('ru-RU')}%`;
}

/** Вариант письма буквой: 1 → A, 2 → B. */
const variantLetter = (n: number) => String.fromCharCode(64 + Math.max(1, n));

function Kpi({ label, value, extra, dot }: { label: string; value: string; extra?: string; dot: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <span className={`h-2 w-2 rounded-sm ${dot}`} />
        {label}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-zinc-900">{value}</span>
        {extra ? <span className="text-sm text-zinc-400">| {extra}</span> : null}
      </div>
    </div>
  );
}

export function CampaignOverview({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [details, setDetails] = useState<CampaignDetailsDto | null>(null);
  const [stats, setStats] = useState<SenderStatsDto | null>(null);
  const [period, setPeriod] = useState<SenderStatsPeriod>('30d');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDetails = useCallback(async () => {
    try {
      setDetails(await fetchCampaign(campaignId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить кампанию');
    }
  }, [campaignId]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  useEffect(() => {
    let active = true;
    setStats(null);
    fetchSenderStats(period, campaignId)
      .then((res) => {
        if (active) setStats(res);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить статистику');
      });
    return () => {
      active = false;
    };
  }, [campaignId, period]);

  const toggleRun = async () => {
    if (!details) return;
    setBusy(true);
    setError(null);
    try {
      await patchCampaign(campaignId, details.campaign.status === 'running' ? 'pause' : 'start');
      await loadDetails();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  };

  const campaign = details?.campaign;
  const status = campaign ? STATUS_PILL[campaign.status] : null;
  const totals = stats?.totals;

  // Шаги цепочки с вариантами: из настроек (что задумано) и из счётчиков (что ушло).
  const variantStats = details?.variantStats ?? [];
  const stepNos = [...new Set([
    ...(details?.steps ?? []).map((s) => s.step_no),
    ...variantStats.map((v) => v.step),
  ])].sort((a, b) => a - b);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* Шапка: назад, название, статус, пуск/пауза и настройки. */}
      <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-zinc-200 pb-4">
        <button
          type="button"
          onClick={() => router.push('/tools/sender' as Route)}
          aria-label="К списку кампаний"
          title="К списку кампаний"
          className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 truncate text-xl font-semibold text-zinc-900">{campaign?.name ?? 'Кампания'}</h1>
        {status ? (
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${status.pill}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.text}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {campaign && campaign.status !== 'done' ? (
            <button
              type="button"
              onClick={() => void toggleRun()}
              disabled={busy}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:opacity-60 ${
                campaign.status === 'running'
                  ? 'border border-zinc-300 text-zinc-700 hover:bg-zinc-100'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500'
              }`}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : campaign.status === 'running' ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {campaign.status === 'running' ? 'Пауза' : campaign.status === 'paused' ? 'Продолжить' : 'Запустить'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => router.push(`/tools/sender/campaigns/${campaignId}/settings` as Route)}
            aria-label="Настройки кампании"
            title="Настройки кампании: письма, база, ящики, расписание"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      <div className="mb-4 inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
        {PERIODS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setPeriod(item.id)}
            className={`rounded-md px-3 py-1 text-sm font-semibold transition ${
              period === item.id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {!stats || !totals ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-5 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Kpi label="Начали цепочку" value={nf(totals.reached)} dot="bg-blue-500" />
            <Kpi label="Всего отправлено" value={nf(stats.letters.sent)} dot="bg-sky-500" />
            <Kpi label="Ответили" value={percent(totals.replied, totals.reached)} extra={nf(totals.replied)} dot="bg-emerald-500" />
            <Kpi label="Лиды" value={nf(totals.leads)} dot="bg-violet-500" />
            <Kpi label="Отбои" value={percent(totals.bounced, totals.reached)} extra={nf(totals.bounced)} dot="bg-red-500" />
          </div>

          <DailyChart days={stats.days} />

          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <div className="flex items-baseline justify-between px-5 pt-4">
              <h3 className="text-sm font-semibold text-zinc-900">По шагам цепочки</h3>
              <span className="text-xs text-zinc-400">за всё время</span>
            </div>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="sender-table-head border-y border-zinc-200 bg-blue-50/60 text-left text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                  <th className="px-5 py-2.5">Шаг</th>
                  <th className="px-3 py-2.5">Отправлено</th>
                  <th className="px-3 py-2.5">Ответили</th>
                  <th className="px-3 py-2.5">% ответов</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {stepNos.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-zinc-400">Писем в цепочке пока нет.</td>
                  </tr>
                ) : (
                  stepNos.flatMap((step) => {
                    const variants = variantStats.filter((v) => v.step === step);
                    const sent = variants.reduce((sum, v) => sum + v.sent, 0);
                    const replied = variants.reduce((sum, v) => sum + v.replied, 0);
                    // Варианты показываем, только если шаг — А/Б-тест.
                    const variantNos = [...new Set([
                      ...(details?.steps ?? []).filter((s) => s.step_no === step).map((s) => s.variant_no ?? 1),
                      ...variants.map((v) => v.variant),
                    ])].sort((a, b) => a - b);
                    const rows = [
                      <tr key={`s${step}`} className="font-medium text-zinc-900">
                        <td className="px-5 py-2.5">Шаг {step}</td>
                        <td className="px-3 py-2.5 tabular-nums">{nf(sent)}</td>
                        <td className="px-3 py-2.5 tabular-nums">{nf(replied)}</td>
                        <td className={`px-3 py-2.5 tabular-nums ${replied ? 'text-emerald-600' : 'text-zinc-400'}`}>{percent(replied, sent)}</td>
                      </tr>,
                    ];
                    if (variantNos.length > 1) {
                      for (const no of variantNos) {
                        const v = variants.find((item) => item.variant === no);
                        rows.push(
                          <tr key={`s${step}v${no}`} className="text-zinc-600">
                            <td className="py-2 pl-10 pr-3">
                              <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-blue-100 text-xs font-semibold text-blue-700">
                                {variantLetter(no)}
                              </span>
                            </td>
                            <td className="px-3 py-2 tabular-nums">{nf(v?.sent ?? 0)}</td>
                            <td className="px-3 py-2 tabular-nums">{nf(v?.replied ?? 0)}</td>
                            <td className="px-3 py-2 tabular-nums">{percent(v?.replied ?? 0, v?.sent ?? 0)}</td>
                          </tr>,
                        );
                      }
                    }
                    return rows;
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
