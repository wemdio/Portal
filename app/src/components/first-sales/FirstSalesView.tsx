'use client';

import { useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import { bucketRange } from '@/lib/firstSales/buckets';
import type { FirstSalesSeries } from '@/lib/firstSales/metrics';
import FiltersBar, { getDefaultFilters, type FiltersState } from '@/components/first-sales/FiltersBar';
import KpiRow from '@/components/first-sales/KpiRow';
import TimeSeriesChart from '@/components/first-sales/TimeSeriesChart';
import FunnelChart from '@/components/first-sales/FunnelChart';
import SourceTable, { drillKey } from '@/components/first-sales/SourceTable';
import SourceMapEditor from '@/components/first-sales/SourceMapEditor';
import MeetingLinksEditor from '@/components/first-sales/MeetingLinksEditor';

type SummaryResponse = FirstSalesSeries & {
  previousTotals: FirstSalesSeries['totals'];
  syncedAt: string | null;
};

/** `YYYY-MM-DD` → `ДД.ММ.ГГГГ` строкой, без `new Date`: разбор ISO-даты
 *  подставил бы часовой пояс браузера и мог бы съехать на день. */
function formatDay(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

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
  /** Корзина, выбранная кликом по графику; null — таблица за весь период. */
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  /**
   * Сводка за одну корзину. Отдельным запросом, а не срезом уже загруженной:
   * `bySource` приходит агрегированным по всему окну, и разложить его обратно
   * по дням на клиенте нечем.
   */
  const [bucketData, setBucketData] = useState<{ key: string; data: SummaryResponse } | null>(null);
  const [bucketLoading, setBucketLoading] = useState(false);

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

  // Границы выбранной корзины, обрезанные периодом фильтра: недельная и
  // месячная корзины на краях выходят за него, и без обрезки таблица показала
  // бы дни, которых нет ни в графике, ни в карточках сверху.
  const selection = useMemo(() => {
    if (!selectedBucket) return null;
    const range = bucketRange(selectedBucket, filters.groupBy);
    return {
      from: range.from < filters.from ? filters.from : range.from,
      to: range.to > filters.to ? filters.to : range.to,
    };
  }, [selectedBucket, filters.groupBy, filters.from, filters.to]);

  const channelKey = filters.channels.join(',');

  useEffect(() => {
    if (!selection || !selectedBucket) return;
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setBucketLoading(true);
      try {
        const qs = new URLSearchParams({ from: selection.from, to: selection.to, groupBy: 'day' });
        for (const channel of filters.channels) qs.append('channel', channel);

        const res = await authFetch(`/api/analytics/first-sales/summary?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SummaryResponse;
        if (!active) return;
        setBucketData({ key: selectedBucket, data: json });
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Не роняем дашборд из-за разреза по одной корзине: таблица просто
        // останется за весь период, что видно по отсутствию плашки.
        logError('first-sales.bucket.fetch_failed', e);
        setBucketData(null);
      } finally {
        if (active) setBucketLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- каналы сравниваем строкой: массив меняет тождество на каждом рендере
  }, [selection, selectedBucket, channelKey, reloadKey]);

  // Данные корзины показываем, только если они от ТЕКУЩЕЙ выбранной корзины.
  // Сравнение по ключу вместо сброса состояния эффектом: пока летит новый
  // запрос, старые числа не подставляются под новую подпись.
  const bucketRows = bucketData && bucketData.key === selectedBucket ? bucketData.data.bySource : null;

  // Период для таблицы и её drill-down: сужённый, если корзина выбрана. Так
  // раскрытие строки со сделками само отфильтруется по тому же дню.
  const tableFilters = selection ? { ...filters, from: selection.from, to: selection.to } : filters;

  const selectionLabel = selection
    ? selection.from === selection.to
      ? formatDay(selection.from)
      : `${formatDay(selection.from)} — ${formatDay(selection.to)}`
    : null;

  const isEmpty = !!data && data.totals.leads === 0 && data.bySource.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Первичка</h1>
        <p className="text-xs text-zinc-500">Воронка первичных продаж: лиды, квалификация, встречи и договоры.</p>
      </div>

      {/* Сброс выбранной корзины — здесь, а не эффектом на смену фильтров:
          после смены периода прежней корзины в ряду может не быть вовсе. */}
      <FiltersBar
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setSelectedBucket(null);
        }}
      />

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
              {/* Воронка перед графиком по времени: она отвечает на первый
                  вопрос («сколько доходит от этапа к этапу»), а динамика по
                  корзинам — уже на второй. */}
              <FunnelChart totals={data.totals} />
              <TimeSeriesChart
                series={data.series}
                groupBy={filters.groupBy}
                selectedKey={selectedBucket}
                onSelectKey={setSelectedBucket}
              />

              {selectionLabel ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 text-xs text-zinc-600">
                  <span>
                    В таблице только <span className="font-semibold text-zinc-900">{selectionLabel}</span>
                    {bucketLoading ? ' — загружаем…' : ''}. Воронка, карточки и график сверху по-прежнему за весь
                    период.
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedBucket(null)}
                    className="ml-auto rounded-full border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 hover:bg-white"
                  >
                    Показать весь период
                  </button>
                </div>
              ) : null}

              {/* key на from/to/channels: смена периода или каналов размонтирует и
                  заново монтирует таблицу, сбрасывая раскрытую drill-down строку
                  вместо того, чтобы показывать под ней сделки уже не того окна.
                  groupBy в ключ не входит — drillKey() это объясняет. */}
              <SourceTable
                key={drillKey(tableFilters)}
                rows={bucketRows ?? data.bySource}
                filters={tableFilters}
              />
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
