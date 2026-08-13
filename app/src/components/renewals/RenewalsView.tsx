'use client';

import { useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import { bucketRange } from '@/lib/firstSales/buckets';
import type { RenewalsResult } from '@/lib/renewals/metrics';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import FiltersBar, { getDefaultFilters, type FiltersState } from '@/components/renewals/FiltersBar';
import KpiRow from '@/components/renewals/KpiRow';
import RenewalsTable from '@/components/renewals/RenewalsTable';
import RenewalsUndatedSection from '@/components/renewals/RenewalsUndatedSection';
import RenewalsChart from '@/components/renewals/RenewalsChart';
import RenewalsFunnel from '@/components/renewals/RenewalsFunnel';

type SummaryResponse = RenewalsResult & { tableRows: RenewalTableRow[]; undatedRows: RenewalTableRow[] };

/** `YYYY-MM-DD` → `ДД.ММ.ГГГГ` строкой, без `new Date`: разбор ISO-даты
 *  подставил бы часовой пояс браузера и мог бы съехать на день. */
function formatDay(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

export default function RenewalsView() {
  const [filters, setFilters] = useState<FiltersState>(() => getDefaultFilters());
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Корзина, выбранная кликом по графику; null — показываем весь период. */
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);

  // Тот же приём, что в FirstSalesView: AbortController реально обрывает
  // устаревший запрос при быстрой смене фильтров, флаг `active` подстраховывает
  // на случай, если промис успел зарезолвиться до того, как abort долетел.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, groupBy: filters.groupBy });
        if (filters.kpiMin !== '') qs.set('kpiMin', filters.kpiMin);
        if (filters.kpiMax !== '') qs.set('kpiMax', filters.kpiMax);

        const res = await authFetch(`/api/analytics/renewals/summary?${qs.toString()}`, {
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
        logError('renewals.summary.fetch_failed', e);
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
  }, [filters]);

  // Границы выбранной корзины. Ключ корзины и `paymentDate` строки — оба
  // `YYYY-MM-DD`, поэтому сравниваем строками: для этого формата
  // лексикографический порядок совпадает с хронологическим.
  const selection = useMemo(
    () => (selectedBucket ? bucketRange(selectedBucket, filters.groupBy) : null),
    [selectedBucket, filters.groupBy],
  );

  const visibleRows = useMemo(() => {
    const rows = data?.tableRows ?? [];
    if (!selection) return rows;
    return rows.filter(
      (row) => row.paymentDate !== null && row.paymentDate >= selection.from && row.paymentDate <= selection.to,
    );
  }, [data, selection]);

  const selectionLabel = selection
    ? selection.from === selection.to
      ? formatDay(selection.from)
      : `${formatDay(selection.from)} — ${formatDay(selection.to)}`
    : null;

  return (
    <div className="glass-stage space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Продления</h1>
        <p className="text-xs text-zinc-500">
          Проекты с типом «Продление»: сколько продлений, на какую сумму, средний чек и цикл.
        </p>
      </div>

      {/* Сброс выбранной корзины — здесь, а не эффектом на смену фильтров:
          после смены периода прежней корзины в ряду может не быть вовсе, и
          таблица молча оказалась бы пустой. */}
      <FiltersBar
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setSelectedBucket(null);
        }}
      />

      {/* Три состояния одним слотом с постоянными ключами — та же защита, что
          на дашборде первички: тремя независимыми условиями React сверял
          позиции детей и при смене периода оставлял над карточками узел старой
          таблицы (инцидент 13.08.2026). Здесь набор блоков такой же, поэтому и
          лечение одинаковое. */}
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
          <KpiRow totals={data.totals} />

          {/* Воронка выше динамики: она отвечает на «где сейчас проекты и
              сколько доходит до продления», и это первый вопрос. Периодом она
              не режется — иначе из неё выпали бы проекты, которые ещё в работе.
              Источник у неё другой (воронка AMO, не портальные проекты), и это
              сказано в подписи внутри компонента. */}
          <RenewalsFunnel />

          {/* Порядок: сначала динамика, потом расшифровка. График отвечает на
              «как идут дела», таблица — на «а из чего это сложилось». Второй
              вопрос возникает после первого, а не до. */}
          <RenewalsChart
            series={data.series}
            groupBy={filters.groupBy}
            selectedKey={selectedBucket}
            onSelectKey={setSelectedBucket}
          />

          {selectionLabel ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 text-xs text-zinc-600">
              <span>
                В таблице только продления за <span className="font-semibold text-zinc-900">{selectionLabel}</span> —{' '}
                {visibleRows.length}
                {visibleRows.length === 1 ? ' штука' : ' шт.'} из {data.tableRows.length}. Карточки и график сверху
                по-прежнему за весь период.
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

          <RenewalsTable rows={visibleRows} />

          <RenewalsUndatedSection rows={data.undatedRows} />

          {/* Заметка про отсутствующие фильтры — под таблицей, чтобы не
              заставлять первым делом спрашивать «а где канал и сфера»:
              канал заполнен у 3 продлений из 32, поля сферы деятельности в
              схеме нет вообще. Строить фильтр на трёх заполненных значениях
              из тридцати двух значит показать инструмент, который врёт при
              каждом использовании — поэтому фильтров нет, и это осознанный
              отказ, а не забытая часть. */}
          <p className="text-[11px] text-zinc-400">
            Фильтров по каналу маркетинга и сфере деятельности здесь пока нет: канал заполнен только у 3 продлений из
            32, а поле сферы деятельности в базе не заведено. Добавим, когда появятся данные.
          </p>
        </div>
      ) : null}
    </div>
  );
}
