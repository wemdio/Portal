'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { RenewalsResult } from '@/lib/renewals/metrics';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import FiltersBar, { getDefaultFilters, type FiltersState } from '@/components/renewals/FiltersBar';
import KpiRow from '@/components/renewals/KpiRow';
import RenewalsTable from '@/components/renewals/RenewalsTable';
import RenewalsChart from '@/components/renewals/RenewalsChart';

type SummaryResponse = RenewalsResult & { tableRows: RenewalTableRow[] };

export default function RenewalsView() {
  const [filters, setFilters] = useState<FiltersState>(() => getDefaultFilters());
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Пока разбор кандидатов только начался (протокол «Продление N - сумма» в
  // AMO завёлся 2026-08-03), «Не разобрано» почти всегда будет больше, чем
  // «Продлений», — это переходный период, а не поломка дашборда. Баннер стоит
  // прямо там, где цифры выглядят подозрительно, а не только сноской внизу
  // страницы, которую легко пропустить.
  const showBacklogNotice = data !== null && data.totals.unresolved > data.totals.count;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Продления</h1>
        <p className="text-xs text-zinc-500">
          Платежи, подтверждённые как продление — комментарием в AMO, текстом закрытой задачи или решением
          человека. Дата и сумма — из банка (когда и сколько реально пришло), а не из карточки проекта.
        </p>
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
          {showBacklogNotice && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              Неразобранных платежей ({data.totals.unresolved.toLocaleString('ru-RU')}) больше, чем
              подтверждённых продлений ({data.totals.count.toLocaleString('ru-RU')}) — это ожидаемо: разметка
              через AMO началась 3 августа 2026, и старые платежи ещё не прошли проверку человеком. Цифры
              слева уточнятся по мере разбора очереди — это не сбой дашборда.
            </div>
          )}

          <KpiRow totals={data.totals} />

          {/* Порядок: сначала динамика, потом расшифровка. График отвечает на
              «как идут дела», таблица — на «а из чего это сложилось». Второй
              вопрос возникает после первого, а не до. */}
          <RenewalsChart series={data.series} groupBy={filters.groupBy} />

          <RenewalsTable rows={data.tableRows} />

          <p className="text-[11px] text-zinc-400">
            Фильтров по каналу маркетинга и сфере деятельности здесь пока нет — оба атрибута наследуются от
            сделки AMO по ИНН плательщика и ещё не подключены к этому дашборду. Добавим отдельно.
          </p>
        </>
      )}
    </div>
  );
}
