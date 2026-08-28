'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { FiltersState } from '@/components/first-sales/FiltersBar';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

/**
 * Раскрытая строка со сделками — общая для разбивки по источникам и по
 * менеджерам. Обе таблицы отвечают на «что за этой цифрой», и список сделок за
 * ней один и тот же; расходятся они только тем, по какому срезу спрашивают.
 */

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');
const fmtMoney = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/**
 * Чем сделка попала в выбранный период. Ручка отдаёт только те сделки, у
 * которых хоть одно из этих полей заполнено, — но даты в строке остаются
 * собственными датами сделки, и без этой колонки сделка 2024 года со встречей
 * в августе выглядела бы промахом фильтра.
 */
export type InPeriod = {
  lead: boolean;
  qualified: boolean;
  meetings: number;
  contract: boolean;
  money: number;
};

function periodBadges(p: InPeriod): string[] {
  const out: string[] = [];
  if (p.lead) out.push('лид');
  if (p.qualified) out.push('квал');
  if (p.meetings > 0) out.push(p.meetings > 1 ? `встречи · ${p.meetings}` : 'встреча');
  if (p.contract) out.push('договор');
  if (p.money > 0) out.push(fmtMoney(p.money));
  return out;
}

export type DrillLeadRow = {
  amo_id: number;
  name: string | null;
  /** Ответственный в AMO. null — за сделкой никто не закреплён. */
  responsible_name: string | null;
  created_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  /** Что именно этой сделки попало в период — см. `InPeriod`. */
  in_period: InPeriod;
  amo_url: string | null;
};

type LeadsResponse = { rows: DrillLeadRow[]; truncated: boolean };

/**
 * Срез, в который проваливается пользователь. Размеченное объединение, а не
 * пара необязательных полей: ручка принимает ровно один из двух параметров, и
 * тип обязан говорить то же самое.
 */
export type DrillQuery = { source: string } | { manager: string };

/**
 * Колонки drill-down таблицы сделок для общего механизма сортировки. Даты —
 * полные ISO-таймстампы (не `YYYY-MM-DD`, как в продлениях), но тип `'date'`
 * сравнивает их обычным строковым сравнением — для ISO 8601 с одинаковым
 * форматом/офсетом лексикографический порядок совпадает с хронологическим,
 * тем же способом уже отсортирован ответ ручки (`leads/route.ts`,
 * `localeCompare` по `created_at`).
 */
const drillSortColumns: SortColumns<DrillLeadRow> = {
  name: { type: 'string', getValue: (r) => r.name },
  // Сделки без ответственного уедут в конец списка при любом направлении —
  // общее правило хука для пустых значений, и здесь оно как раз кстати: это
  // не «менеджер по имени пусто», а отсутствие данных.
  responsible_name: { type: 'string', getValue: (r) => r.responsible_name },
  created_at: { type: 'date', getValue: (r) => r.created_at },
  first_meeting_at: { type: 'date', getValue: (r) => r.first_meeting_at },
  first_contract_at: { type: 'date', getValue: (r) => r.first_contract_at },
  won_at: { type: 'date', getValue: (r) => r.won_at },
};

/**
 * Ключ, по которому раскрытая строка теряет актуальность. Только from/to/
 * sources влияют на то, какие сделки попадут в drill-down — смена groupBy
 * на сам список сделок не влияет (это только раскладка графика по корзинам),
 * поэтому в ключ не входит: иначе переключение «День/Неделя/Месяц» без
 * причины сворачивало бы открытую строку.
 *
 * FirstSalesView передаёт этот ключ как `key` таблицам: смена периода или
 * источников размонтирует и заново монтирует таблицу, и состояние `expanded`
 * сбрасывается самим React. Это вместо `useEffect(() => setExpanded(null),
 * [key])` — React-доки называют именно `key` правильным способом сброса
 * состояния при смене входных данных (see «Resetting state with a key»), а не
 * побочный эффект, синхронно вызывающий setState. Второе ещё и словило бы
 * правило линтера `react-hooks/set-state-in-effect`.
 */
export function drillKey(filters: FiltersState): string {
  return `${filters.from}|${filters.to}|${filters.sources.join(',')}`;
}

/** Стабильная строка среза — и для зависимостей эффекта, и для логов. */
function queryKey(query: DrillQuery): string {
  return 'source' in query ? `source:${query.source}` : `manager:${query.manager}`;
}

export default function DealDrillDown({
  query,
  filters,
  colSpan,
}: {
  query: DrillQuery;
  filters: FiltersState;
  /** Ширина родительской таблицы в колонках — у источников и менеджеров разная. */
  colSpan: number;
}) {
  const [data, setData] = useState<LeadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = queryKey(query);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        // Фильтр по источникам не передаём: строка, в которую провалились, его
        // уже прошла в сводке — второй раз отсеивать нечего.
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, ...query });

        const res = await authFetch(`/api/analytics/first-sales/leads?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as LeadsResponse;
        if (!active) return;
        setError(null);
        setData(json);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        logError('first-sales.leads.fetch_failed', e, { query: key });
        setError(e instanceof Error ? e.message : 'Не удалось загрузить сделки');
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- from/to/sources уже свёрнуты в drillKey выше уровнем; key меняется вместе со строкой.
  }, [key, filters.from, filters.to, filters.sources.join(',')]);

  // `rows`/`sortedRows` объявлены до ранних return'ов ниже — хуки не могут
  // вызываться условно, а компонент размонтируется/монтируется заново при смене
  // среза, так что своё состояние сортировки здесь и не нужно сбрасывать
  // вручную: React делает это сам.
  const rows = data?.rows ?? [];
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, drillSortColumns);

  if (loading) {
    return (
      <tr>
        <td colSpan={colSpan} className="bg-zinc-50/60 px-3 py-4 text-center text-zinc-400">
          Загрузка сделок…
        </td>
      </tr>
    );
  }

  if (error) {
    return (
      <tr>
        <td colSpan={colSpan} className="bg-zinc-50/60 px-3 py-4 text-center text-red-600">
          Ошибка загрузки сделок: {error}
        </td>
      </tr>
    );
  }

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={colSpan} className="bg-zinc-50/60 px-3 py-4 text-center text-zinc-400">
          Сделок за выбранный период не найдено.
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={colSpan} className="bg-zinc-50/60 px-3 py-3">
        {/* Раскрытая строка живёт внутри таблицы, которая сама уже стеклянная.
            Второй `.glass-frame` дал бы размытие внутри размытия — именно
            вложенность роняет плавность прокрутки. Плотная подложка строк. */}
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-[var(--glass-rows)]">
          <table className="w-full min-w-[760px] text-[11px]">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
                <SortableTh label="Сделка" sortKey="name" sort={sort} onSort={toggleSort} className="px-2.5 py-1.5" />
                <SortableTh
                  label="Менеджер"
                  sortKey="responsible_name"
                  sort={sort}
                  onSort={toggleSort}
                  className="px-2.5 py-1.5"
                />
                <SortableTh
                  label="Создана"
                  sortKey="created_at"
                  sort={sort}
                  onSort={toggleSort}
                  className="px-2.5 py-1.5"
                />
                <SortableTh
                  label={
                    <span title="Дата этапа AMO «Встреча проведена» — историческая метка CRM, не метрика «Встречи» на дашборде. Метрика считается по записям разговоров и может с этой датой не совпадать.">
                      Этап AMO
                    </span>
                  }
                  sortKey="first_meeting_at"
                  sort={sort}
                  onSort={toggleSort}
                  className="px-2.5 py-1.5"
                />
                <SortableTh
                  label="Договор"
                  sortKey="first_contract_at"
                  sort={sort}
                  onSort={toggleSort}
                  className="px-2.5 py-1.5"
                />
                <SortableTh
                  label="Оплата"
                  sortKey="won_at"
                  sort={sort}
                  onSort={toggleSort}
                  className="px-2.5 py-1.5"
                />
                {/* Не сортируется: это не величина, а перечисление причин, по
                    которым сделка попала в период. */}
                <th className="px-2.5 py-1.5 font-medium">
                  <span title="Что этой сделки попало в выбранный период: лид (создана), квал, встреча по записи разговора, договор, деньги. Даты в строке — собственные даты сделки и могут быть старше периода.">
                    В периоде
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((lead) => (
                <tr key={lead.amo_id} className="border-b border-zinc-50 last:border-0">
                  <td className="px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {lead.amo_url ? (
                        <a
                          href={lead.amo_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {lead.name || `Сделка #${lead.amo_id}`}
                        </a>
                      ) : (
                        <span className="text-zinc-700">{lead.name || `Сделка #${lead.amo_id}`}</span>
                      )}
                      {!lead.history_complete && (
                        <span
                          title="Сделка создана раньше глубины синка событий AMO — даты встречи/договора могли произойти до горизонта, который мы видим, и посчитаны быть не могут."
                          className="cursor-help rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                        >
                          история неполная
                        </span>
                      )}
                    </div>
                  </td>
                  {/* Пусто, а не прочерк: у соседних колонок прочерк значит
                      «этап не достигнут», а тут — «в CRM не закреплён», и
                      путать эти два состояния одним символом не стоит. */}
                  <td className="px-2.5 py-1.5 text-zinc-600">
                    {lead.responsible_name || <span className="text-zinc-400">не закреплён</span>}
                  </td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.created_at)}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.first_meeting_at)}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.first_contract_at)}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.won_at)}</td>
                  <td className="px-2.5 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {periodBadges(lead.in_period).map((badge) => (
                        <span
                          key={badge}
                          className="rounded-full border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-600"
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.truncated && (
          <p className="mt-1.5 text-[11px] text-amber-700">
            Показаны первые {rows.length} сделок — список обрезан, всего их больше.
          </p>
        )}
      </td>
    </tr>
  );
}
