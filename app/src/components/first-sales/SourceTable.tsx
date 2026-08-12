'use client';

import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import { CHANNEL_LABELS } from '@/lib/firstSales/sourceChannels';
import type { SourceBreakdown } from '@/lib/firstSales/metrics';
import type { FiltersState } from '@/components/first-sales/FiltersBar';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

const fmt = (n: number) => n.toLocaleString('ru-RU');
const fmtMoney = (n: number) => (n > 0 ? `${Math.round(n).toLocaleString('ru-RU')} ₽` : '—');
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '—');
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

type DrillLeadRow = {
  amo_id: number;
  name: string | null;
  /** Ответственный в AMO. null — за сделкой никто не закреплён. */
  responsible_name: string | null;
  created_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  amo_url: string | null;
};

type LeadsResponse = { rows: DrillLeadRow[]; truncated: boolean };

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
 * channels влияют на то, какие сделки попадут в drill-down — смена groupBy
 * на сам список сделок не влияет (это только раскладка графика по корзинам),
 * поэтому в ключ не входит: иначе переключение «День/Неделя/Месяц» без
 * причины сворачивало бы открытую строку.
 *
 * FirstSalesView передаёт этот ключ как `key` для <SourceTable>: смена
 * периода/каналов размонтирует и заново монтирует таблицу, и состояние
 * `expanded` сбрасывается самим React. Это вместо `useEffect(() =>
 * setExpanded(null), [key])` — React-доки называют именно `key` правильным
 * способом сброса состояния при смене входных данных (see «Resetting state
 * with a key»), а не побочный эффект, синхронно вызывающий setState. Второе
 * ещё и словило бы правило линтера `react-hooks/set-state-in-effect`.
 */
export function drillKey(filters: FiltersState): string {
  return `${filters.from}|${filters.to}|${filters.channels.join(',')}`;
}

function DrillDownRows({ source, filters }: { source: string; filters: FiltersState }) {
  const [data, setData] = useState<LeadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, source });
        for (const channel of filters.channels) qs.append('channel', channel);

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
        logError('first-sales.leads.fetch_failed', e, { source });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- from/to/channels уже свёрнуты в drillKey выше уровнем; source меняется вместе со строкой.
  }, [source, filters.from, filters.to, filters.channels.join(',')]);

  // `rows`/`sortedRows` объявлены до ранних return'ов ниже — хуки не могут
  // вызываться условно, а DrillDownRows размонтируется/монтируется заново при
  // смене source (см. комментарий у SourceTable), так что своё состояние
  // сортировки здесь и не нужно сбрасывать вручную: React делает это сам.
  const rows = data?.rows ?? [];
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, drillSortColumns);

  if (loading) {
    return (
      <tr>
        <td colSpan={8} className="bg-zinc-50/60 px-3 py-4 text-center text-zinc-400">
          Загрузка сделок…
        </td>
      </tr>
    );
  }

  if (error) {
    return (
      <tr>
        <td colSpan={8} className="bg-zinc-50/60 px-3 py-4 text-center text-red-600">
          Ошибка загрузки сделок: {error}
        </td>
      </tr>
    );
  }

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={8} className="bg-zinc-50/60 px-3 py-4 text-center text-zinc-400">
          Сделок за выбранный период не найдено.
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={8} className="bg-zinc-50/60 px-3 py-3">
        {/* Раскрытая строка живёт внутри таблицы, которая сама уже стеклянная.
            Второй `.glass-frame` дал бы размытие внутри размытия — именно
            вложенность роняет плавность прокрутки. Плотная подложка строк. */}
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-[var(--glass-rows)]">
          <table className="w-full min-w-[660px] text-[11px]">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
                <SortableTh
                  label="Сделка"
                  sortKey="name"
                  sort={sort}
                  onSort={toggleSort}
                  className="px-2.5 py-1.5"
                />
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
                    {lead.responsible_name || (
                      <span className="text-zinc-400">не закреплён</span>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.created_at)}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.first_meeting_at)}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.first_contract_at)}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-zinc-600">{fmtDate(lead.won_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.truncated && (
          <p className="mt-1.5 text-[11px] text-amber-700">
            Показаны первые {rows.length} сделок — список обрезан, в источнике их больше.
          </p>
        )}
      </td>
    </tr>
  );
}

/**
 * Колонки внешней таблицы разбивки по источникам.
 *
 * «Доля» сюда сознательно не входит — она вычисляется из `leads` тем же
 * `totalLeads` для всех строк (`pct(row.leads, totalLeads)`), поэтому её
 * сортировка ВСЕГДА даёт тот же порядок строк, что сортировка по «Лиды»: доля
 * — монотонное преобразование лидов при фиксированном знаменателе, знак
 * разницы двух долей совпадает со знаком разницы двух `leads`. Возможного
 * случая, когда порядок разошёлся бы, нет. Кликабельный заголовок для колонки,
 * которая всегда дублирует соседнюю, — не польза, а обман: подписывает
 * пользователя ожидать независимую сортировку там, где её нет. Поэтому
 * заголовок остаётся обычным `<th>`, как раньше.
 */
const sourceSortColumns: SortColumns<SourceBreakdown> = {
  source: { type: 'string', getValue: (r) => r.source },
  channel: { type: 'string', getValue: (r) => CHANNEL_LABELS[r.channel] },
  leads: { type: 'number', getValue: (r) => r.leads },
  qualified: { type: 'number', getValue: (r) => r.qualified },
  meetings: { type: 'number', getValue: (r) => r.meetings },
  contracts: { type: 'number', getValue: (r) => r.contracts },
  money: { type: 'number', getValue: (r) => r.money },
};

export default function SourceTable({ rows, filters }: { rows: SourceBreakdown[]; filters: FiltersState }) {
  const totalLeads = rows.reduce((sum, r) => sum + r.leads, 0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, sourceSortColumns);

  const toggle = (source: string) => {
    setExpanded((cur) => (cur === source ? null : source));
  };

  return (
    <div className="glass-frame overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
            <SortableTh label="Источник" sortKey="source" sort={sort} onSort={toggleSort} />
            <SortableTh label="Канал" sortKey="channel" sort={sort} onSort={toggleSort} />
            <SortableTh label="Лиды" sortKey="leads" sort={sort} onSort={toggleSort} align="right" />
            <th className="px-3 py-2 text-right font-medium">Доля</th>
            <SortableTh label="Квал" sortKey="qualified" sort={sort} onSort={toggleSort} align="right" />
            <SortableTh label="Встречи" sortKey="meetings" sort={sort} onSort={toggleSort} align="right" />
            <SortableTh label="Договоры" sortKey="contracts" sort={sort} onSort={toggleSort} align="right" />
            {/* Деньги, связанные со сделкой по ИНН плательщика. Прочерк —
                «связать не смогли», а не «денег не было»; доля покрытия стоит
                на карточке «Деньги» вверху дашборда. */}
            <SortableTh
              label={
                <span title="Банковские приходы, связанные со сделкой по ИНН плательщика. Прочерк значит «связать не смогли» — ИНН заполнен не у всех сделок.">
                  Деньги
                </span>
              }
              sortKey="money"
              sort={sort}
              onSort={toggleSort}
              align="right"
            />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isOpen = expanded === row.source;
            return (
              <Fragment key={row.source}>
                <tr
                  onClick={() => toggle(row.source)}
                  className="cursor-pointer border-b border-zinc-50 hover:bg-zinc-50/60"
                  aria-expanded={isOpen}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      )}
                      <span className="font-medium text-zinc-800">{row.source || '(не указан)'}</span>
                      {!row.known && (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          нет в справочнике
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-zinc-600">{CHANNEL_LABELS[row.channel]}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.leads)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(row.leads, totalLeads)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.qualified)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.meetings)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.contracts)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmtMoney(row.money)}</td>
                </tr>
                {isOpen && <DrillDownRows source={row.source} filters={filters} />}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-zinc-400">
                Нет данных за выбранный период.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
