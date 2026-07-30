'use client';

import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import { CHANNEL_LABELS } from '@/lib/firstSales/sourceChannels';
import type { SourceBreakdown } from '@/lib/firstSales/metrics';
import type { FiltersState } from '@/components/first-sales/FiltersBar';

const fmt = (n: number) => n.toLocaleString('ru-RU');
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '—');
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

type DrillLeadRow = {
  amo_id: number;
  name: string | null;
  created_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  amo_url: string | null;
};

type LeadsResponse = { rows: DrillLeadRow[]; truncated: boolean };

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

  if (loading) {
    return (
      <tr>
        <td colSpan={7} className="bg-zinc-50/60 px-3 py-4 text-center text-zinc-400">
          Загрузка сделок…
        </td>
      </tr>
    );
  }

  if (error) {
    return (
      <tr>
        <td colSpan={7} className="bg-zinc-50/60 px-3 py-4 text-center text-red-600">
          Ошибка загрузки сделок: {error}
        </td>
      </tr>
    );
  }

  const rows = data?.rows ?? [];

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={7} className="bg-zinc-50/60 px-3 py-4 text-center text-zinc-400">
          Сделок за выбранный период не найдено.
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={7} className="bg-zinc-50/60 px-3 py-3">
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full min-w-[560px] text-[11px]">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-2.5 py-1.5 font-medium">Сделка</th>
                <th className="px-2.5 py-1.5 font-medium">Создана</th>
                <th
                  className="px-2.5 py-1.5 font-medium"
                  title="Дата этапа AMO «Встреча проведена» — историческая метка CRM, не метрика «Встречи» на дашборде. Метрика считается по записям разговоров и может с этой датой не совпадать."
                >
                  Этап AMO
                </th>
                <th className="px-2.5 py-1.5 font-medium">Договор</th>
                <th className="px-2.5 py-1.5 font-medium">Оплата</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((lead) => (
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

export default function SourceTable({ rows, filters }: { rows: SourceBreakdown[]; filters: FiltersState }) {
  const totalLeads = rows.reduce((sum, r) => sum + r.leads, 0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (source: string) => {
    setExpanded((cur) => (cur === source ? null : source));
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
            <th className="px-3 py-2 font-medium">Источник</th>
            <th className="px-3 py-2 font-medium">Канал</th>
            <th className="px-3 py-2 font-medium text-right">Лиды</th>
            <th className="px-3 py-2 font-medium text-right">Доля</th>
            <th className="px-3 py-2 font-medium text-right">Квал</th>
            <th className="px-3 py-2 font-medium text-right">Встречи</th>
            <th className="px-3 py-2 font-medium text-right">Договоры</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
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
                </tr>
                {isOpen && <DrillDownRows source={row.source} filters={filters} />}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-zinc-400">
                Нет данных за выбранный период.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
