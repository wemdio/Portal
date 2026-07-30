'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { FirstSalesSeries } from '@/lib/firstSales/metrics';
import FiltersBar, { getDefaultFilters, type FiltersState } from '@/components/first-sales/FiltersBar';
import KpiRow from '@/components/first-sales/KpiRow';
import TimeSeriesChart from '@/components/first-sales/TimeSeriesChart';
import SourceTable, { drillKey } from '@/components/first-sales/SourceTable';
import SourceMapEditor from '@/components/first-sales/SourceMapEditor';
import MeetingLinksEditor from '@/components/first-sales/MeetingLinksEditor';

type SummaryResponse = FirstSalesSeries & {
  previousTotals: FirstSalesSeries['totals'];
  syncedAt: string | null;
};

export default function FirstSalesView() {
  const [filters, setFilters] = useState<FiltersState>(() => getDefaultFilters());
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSourceMap, setShowSourceMap] = useState(false);
  const [showMeetingLinks, setShowMeetingLinks] = useState(false);
  // Инкрементируется после сохранения в справочнике источников или в очереди
  // записей встреч, чтобы перезапустить фетч сводки без изменения самих
  // фильтров (эффекты ниже держат его в зависимостях ровно для этого).
  const [reloadKey, setReloadKey] = useState(0);
  // Размер очереди записей без сделки — нужен ДО того, как панель открыта:
  // кнопка-переключатель показывает число рядом с названием, чтобы было
  // видно, есть ли работа, не разворачивая панель. null, пока число ещё не
  // пришло (не «очередь пуста», а «неизвестно»).
  const [meetingQueueCount, setMeetingQueueCount] = useState<{ count: number; truncated: boolean } | null>(null);

  // Фетч в эффекте по ключу = весь объект фильтров. Клик по каналу или пресету
  // периода запускает новый запрос при каждом изменении; быстрые повторные
  // клики иначе дали бы гонку — ответ на устаревший запрос может прийти позже
  // ответа на свежий. Защита в два слоя: AbortController реально обрывает
  // предыдущий fetch (не тратим впустую бэкенд, который тянет и текущее, и
  // прошлое окно), а флаг `active` подстраховывает на случай, если промис уже
  // успел зарезолвиться до того, как abort долетел — тот же идиом, что в
  // analytics/mailbox-load/page.tsx.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, groupBy: filters.groupBy });
        for (const channel of filters.channels) qs.append('channel', channel);

        const res = await authFetch(`/api/analytics/first-sales/summary?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as SummaryResponse;
        if (!active) return;
        setError(null);
        setData(json);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return; // отменено новым фильтром, не ошибка
        logError('first-sales.summary.fetch_failed', e);
        setError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [filters, reloadKey]);

  // Отдельный лёгкий фетч только под счётчик на кнопке — не завязан на
  // showMeetingLinks: число должно быть видно ДО того, как панель открыта
  // (условие reloadKey — то же самое, чем закрывается цикл после сохранения
  // строки в MeetingLinksEditor). Канал сюда не передаём: запись ещё не
  // привязана к сделке, у неё нет канала, по которому можно фильтровать.
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to });
        const res = await authFetch(`/api/analytics/first-sales/meeting-links?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { rows: unknown[]; truncated: boolean };
        if (!active) return;
        setMeetingQueueCount({ count: json.rows.length, truncated: json.truncated });
      } catch (e) {
        if (!active) return;
        // Не роняем весь дашборд из-за счётчика на второстепенной кнопке —
        // просто оставляем число неизвестным (кнопка без числа в скобках).
        logError('first-sales.meeting_links.count_failed', e);
        setMeetingQueueCount(null);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [filters.from, filters.to, reloadKey]);

  const isEmpty = !!data && data.totals.leads === 0 && data.bySource.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Первичка</h1>
        <p className="text-xs text-zinc-500">Воронка первичных продаж: лиды, квалификация, встречи и договоры.</p>
      </div>

      <FiltersBar value={filters} onChange={setFilters} />

      {loading && <div className="py-10 text-center text-sm text-zinc-400">Загрузка…</div>}
      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Ошибка загрузки: {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          <KpiRow totals={data.totals} previousTotals={data.previousTotals} syncedAt={data.syncedAt} />

          {isEmpty ? (
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-8 text-center text-sm text-zinc-400">
              Данных за выбранный период нет.
            </div>
          ) : (
            <>
              <TimeSeriesChart series={data.series} groupBy={filters.groupBy} />
              {/* key на from/to/channels: смена периода или каналов размонтирует и
                  заново монтирует таблицу, сбрасывая раскрытую drill-down строку
                  вместо того, чтобы показывать под ней сделки уже не того окна.
                  groupBy в ключ не входит — drillKey() это объясняет. */}
              <SourceTable key={drillKey(filters)} rows={data.bySource} filters={filters} />
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSourceMap((v) => !v)}
              className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
              aria-expanded={showSourceMap}
            >
              {showSourceMap ? 'Скрыть справочник источников' : 'Справочник источников'}
            </button>
            <button
              type="button"
              onClick={() => setShowMeetingLinks((v) => !v)}
              className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
              aria-expanded={showMeetingLinks}
            >
              {showMeetingLinks ? 'Скрыть записи без сделки' : 'Записи без сделки'}
              {meetingQueueCount && (
                <span className={meetingQueueCount.count > 0 ? ' font-semibold text-amber-700' : ' text-zinc-400'}>
                  {' '}
                  ({meetingQueueCount.count}
                  {meetingQueueCount.truncated ? '+' : ''})
                </span>
              )}
            </button>
          </div>

          {showSourceMap && (
            <SourceMapEditor onSaved={() => setReloadKey((k) => k + 1)} />
          )}

          {showMeetingLinks && (
            <MeetingLinksEditor
              from={filters.from}
              to={filters.to}
              onSaved={() => setReloadKey((k) => k + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}
