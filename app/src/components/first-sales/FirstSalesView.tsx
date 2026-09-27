'use client';

import { useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import { bucketRange } from '@/lib/firstSales/buckets';
import type { FirstSalesSeries } from '@/lib/firstSales/metrics';
import FiltersBar, { clampSharedPeriod, getDefaultFilters, type FiltersState } from '@/components/first-sales/FiltersBar';
import { readSharedPeriod, writeSharedPeriod } from '@/lib/firstSales/sharedPeriod';
import RenewalsFunnel from '@/components/renewals/RenewalsFunnel';
import KpiRow from '@/components/first-sales/KpiRow';
import TimeSeriesChart from '@/components/first-sales/TimeSeriesChart';
import SourceTable from '@/components/first-sales/SourceTable';
import { drillKey } from '@/components/first-sales/DealDrillDown';
import ManagerTable from '@/components/first-sales/ManagerTable';
import MeetingLinksEditor from '@/components/first-sales/MeetingLinksEditor';

type SummaryResponse = FirstSalesSeries & {
  previousTotals: FirstSalesSeries['totals'];
  /** Границы окна, с которым сравниваются дельты под плитками (`YYYY-MM-DD`). */
  previousFrom: string;
  previousTo: string;
  syncedAt: string | null;
};

/** `YYYY-MM-DD` → `ДД.ММ.ГГГГ` строкой, без `new Date`: разбор ISO-даты
 *  подставил бы часовой пояс браузера и мог бы съехать на день. */
function formatDay(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

/** Параметр адреса страницы с режимом счёта: `?cohort=0` — «без когорты».
 *  Режим по умолчанию в адрес не пишется, чтобы старые ссылки не менялись. */
const COHORT_URL_PARAM = 'cohort';

/**
 * Режим счёта живёт в адресе страницы, а не только в состоянии: ссылку «без
 * когорты» пересылают CEO, и открыться она обязана в том же режиме.
 * `replaceState`, а не навигация роутера: страница не перерисовывается, и
 * каждый клик по переключателю не плодит запись в истории «Назад».
 */
function readCohortFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get(COHORT_URL_PARAM) !== '0';
}

function writeCohortToUrl(cohort: boolean): void {
  const url = new URL(window.location.href);
  if (cohort) url.searchParams.delete(COHORT_URL_PARAM);
  else url.searchParams.set(COHORT_URL_PARAM, '0');
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url.href);
}

/** Строка запроса сводки — одна на весь период и на выбранную корзину. */
function summaryQuery(filters: FiltersState, period: { from: string; to: string }, groupBy: string): string {
  const qs = new URLSearchParams({ from: period.from, to: period.to, groupBy });
  for (const source of filters.sources) qs.append('source', source);
  if (!filters.cohort) qs.set('cohort', '0');
  // Окно уже выбранного периода (клик по столбцу) — период для «без
  // когорты» остаётся выбранным целиком, см. `cohortFrom` в params.ts.
  if (period.from !== filters.from || period.to !== filters.to) {
    qs.set('cohortFrom', filters.from);
    qs.set('cohortTo', filters.to);
  }
  return qs.toString();
}

export default function FirstSalesView() {
  const [filters, setFilters] = useState<FiltersState>(() => getDefaultFilters());
  /**
   * Период переносится между дашбордами первички и продлений (localStorage,
   * см. sharedPeriod.ts). Читается в эффекте, а не в инициализаторе useState:
   * страница рендерится и на сервере, где localStorage нет, и разные значения
   * на сервере и в браузере дали бы ошибку гидрации. Пока период не восстановлен,
   * запрос сводки не уходит — иначе на каждое открытие экрана летели бы два
   * запроса подряд, за дефолтные 30 дней и за сохранённый период.
   */
  const [periodRestored, setPeriodRestored] = useState(false);
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showMeetingLinks, setShowMeetingLinks] = useState(false);
  // Инкрементируется после сохранения в очереди
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
  // Режим счёта восстанавливается здесь же, из адреса страницы, — по той же
  // причине, что и период: на сервере адреса браузера нет, а сводка до
  // восстановления не запрашивается.
  useEffect(() => {
    const stored = readSharedPeriod();
    const cohort = readCohortFromUrl();
    const period = stored ? clampSharedPeriod(stored) : null;
    setFilters((f) => {
      const from = period?.from ?? f.from;
      const to = period?.to ?? f.to;
      return f.from === from && f.to === to && f.cohort === cohort ? f : { ...f, from, to, cohort };
    });
    setPeriodRestored(true);
  }, []);

  useEffect(() => {
    if (!periodRestored) return;
    writeSharedPeriod({ from: filters.from, to: filters.to });
  }, [periodRestored, filters.from, filters.to]);

  useEffect(() => {
    if (!periodRestored) return;
    writeCohortToUrl(filters.cohort);
  }, [periodRestored, filters.cohort]);

  useEffect(() => {
    if (!periodRestored) return;
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = summaryQuery(filters, filters, filters.groupBy);

        const res = await authFetch(`/api/analytics/first-sales/summary?${qs}`, {
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
  }, [filters, reloadKey, periodRestored]);

  // Отдельный лёгкий фетч только под счётчик на кнопке — не завязан на
  // showMeetingLinks: число должно быть видно ДО того, как панель открыта
  // (условие reloadKey — то же самое, чем закрывается цикл после сохранения
  // строки в MeetingLinksEditor). Источник сюда не передаём: запись ещё не
  // привязана к сделке, у неё нет источника, по которому можно фильтровать.
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        // countOnly=1 — роут не тянет расшифровки записей (мегабайты текста
        // ради одного числа), а отдаёт сразу размер очереди.
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, countOnly: '1' });
        const res = await authFetch(`/api/analytics/first-sales/meeting-links?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { count: number; truncated: boolean };
        if (!active) return;
        setMeetingQueueCount({ count: json.count, truncated: json.truncated });
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

  const sourceKey = filters.sources.join(',');

  useEffect(() => {
    if (!selection || !selectedBucket) return;
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setBucketLoading(true);
      try {
        const qs = summaryQuery(filters, selection, 'day');

        const res = await authFetch(`/api/analytics/first-sales/summary?${qs}`, {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- источники сравниваем строкой: массив меняет тождество на каждом рендере
  }, [selection, selectedBucket, sourceKey, filters.cohort, reloadKey]);

  // Данные корзины показываем, только если они от ТЕКУЩЕЙ выбранной корзины.
  // Сравнение по ключу вместо сброса состояния эффектом: пока летит новый
  // запрос, старые числа не подставляются под новую подпись.
  const bucketRows = bucketData && bucketData.key === selectedBucket ? bucketData.data.bySource : null;

  // Период для таблицы и её drill-down: сужённый, если корзина выбрана. Так
  // раскрытие строки со сделками само отфильтруется по тому же дню.
  // Период целиком уходит в cohortFrom/cohortTo: без когорты «заведена в
  // периоде» считается по нему, а не по выбранному дню.
  const tableFilters: FiltersState = selection
    ? { ...filters, from: selection.from, to: selection.to, cohortFrom: filters.from, cohortTo: filters.to }
    : filters;

  const selectionLabel = selection
    ? selection.from === selection.to
      ? formatDay(selection.from)
      : `${formatDay(selection.from)} — ${formatDay(selection.to)}`
    : null;

  const isEmpty = !!data && data.totals.leads === 0 && data.bySource.length === 0;

  return (
    <div className="glass-stage space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Первичка</h1>
        <p className="text-xs text-zinc-500">Воронка первичных продаж: лиды, квалификация, встречи и договоры.</p>
      </div>

      {/* Сброс выбранной корзины — здесь, а не эффектом на смену фильтров:
          после смены периода прежней корзины в ряду может не быть вовсе. */}
      <FiltersBar
        value={filters}
        sources={data?.availableSources ?? []}
        onChange={(next) => {
          setFilters(next);
          setSelectedBucket(null);
        }}
      />

      {/* Три состояния — три СОСЕДА в одном слоте, с постоянными ключами, а не
          три независимых условия подряд.
          Раньше загрузка, ошибка и содержимое стояли отдельными выражениями:
          при смене периода React видел, что на месте второго ребёнка вместо
          `false` появился div, а фрагмент с содержимым исчез, — и, сверяя
          позиции, оставлял под индексом 2 узел старой таблицы источников.
          На экране это выглядело как копия таблицы, приклеенная над карточками
          и воронкой, с цифрами прошлого периода (13.08.2026).
          Ключи `loading`/`error`/`content` делают ветки различимыми: React уже
          не может принять одну за другую и переиспользовать чужой DOM. */}
      {loading ? (
        <div key="loading" className="py-10 text-center text-sm text-zinc-400">Загрузка…</div>
      ) : error ? (
        <div
          key="error"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          Ошибка загрузки: {error}
        </div>
      ) : data ? (
        <div key="content" className="space-y-4">
          <KpiRow
            totals={data.totals}
            previousTotals={data.previousTotals}
            previousFrom={data.previousFrom}
            previousTo={data.previousTo}
            syncedAt={data.syncedAt}
            cohort={filters.cohort}
            onNoSourceClick={() => {
              setFilters((f) => ({ ...f, sources: ['none'] }));
              setSelectedBucket(null);
            }}
          />

          {isEmpty ? (
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-8 text-center text-sm text-zinc-400">
              Данных за выбранный период нет.
            </div>
          ) : (
            <>
              {/* Воронка перед графиком по времени: она отвечает на первый
                  вопрос — «на каком этапе стоят сделки периода», а динамика по
                  корзинам — уже на второй.

                  С 11.09.2026 воронка первички — та же, что у продлений: каждая
                  сделка один раз, на этапе AMO, где стояла в последний день
                  периода (lib/firstSales/stageFunnel.ts). Рядом — список этих
                  сделок, клик открывает карточку с историей переходов. Прежняя
                  воронка метрик «Лиды → Квал → Встречи → Продажи» смешивала
                  когорту с датами событий и не показывала, где сделки стоят. */}
              <RenewalsFunnel
                filters={filters}
                endpoint="/api/analytics/first-sales/stage-funnel"
                dealEndpoint="/api/analytics/first-sales/deal"
                title="Воронка первички за период"
                subtitle={
                  filters.cohort
                    ? 'На каком этапе была каждая сделка в последний день периода — среди заведённых или сдвинутых в нём. История переходов — в карточке сделки.'
                    : 'На каком этапе была каждая сделка в последний день периода — только среди заведённых в нём (без когорты). История переходов — в карточке сделки.'
                }
                emptyText="За выбранный период в воронке новых лидов сделок не было — попробуйте расширить период."
                ariaLabel="Воронка первички по этапам AMO"
                outcomesLabel="Итог:"
                listSubtitle="Каждая сделка — на этапе, где была в последний день периода. Клик открывает карточку с историей переходов. Внизу — успешные и закрытые в минус."
                listOutcomesLabel="Итог"
              />
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

              {/* key на from/to/sources: смена периода или источников размонтирует и
                  заново монтирует таблицу, сбрасывая раскрытую drill-down строку
                  вместо того, чтобы показывать под ней сделки уже не того окна.
                  groupBy в ключ не входит — drillKey() это объясняет.

                  Префиксы `sources:`/`managers:` обязательны. Без них у двух
                  СОСЕДНИХ элементов оказывался один и тот же ключ, а React
                  требует уникальности ключей среди соседей: при клике по дню на
                  графике ключ менялся, сопоставить старых детей с новыми React
                  не мог и оставлял прежние таблицы на экране — с каждым кликом
                  их становилось на две больше. */}
              <SourceTable
                key={`sources:${drillKey(tableFilters)}`}
                rows={bucketRows ?? data.bySource}
                filters={tableFilters}
              />

              <ManagerTable
                key={`managers:${drillKey(tableFilters)}`}
                rows={data.byManager}
                filters={tableFilters}
              />
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
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

          {showMeetingLinks && (
            <MeetingLinksEditor
              from={filters.from}
              to={filters.to}
              onSaved={() => setReloadKey((k) => k + 1)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
