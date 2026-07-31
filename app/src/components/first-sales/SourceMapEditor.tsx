'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import { FIRST_SALES_CHANNELS, CHANNEL_LABELS, type FirstSalesChannel } from '@/lib/firstSales/sourceChannels';

type SourceMapRow = {
  id: number;
  source: string;
  channel: FirstSalesChannel;
  display_name: string | null;
  sort_order: number;
  updated_at: string;
};

/** Нераспределённые источники — сверху: это очередь работы для продаж, а не
 *  справочная информация вперемешку с уже разложенными. Внутри группы —
 *  исходный sort_order из справочника. */
function sortRows(rows: SourceMapRow[]): SourceMapRow[] {
  return [...rows].sort((a, b) => {
    const rank = (r: SourceMapRow) => (r.channel === 'unassigned' ? 0 : 1);
    return rank(a) - rank(b) || a.sort_order - b.sort_order;
  });
}

export default function SourceMapEditor({ onSaved }: { onSaved: () => void }) {
  const [rows, setRows] = useState<SourceMapRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Наборы, а не одиночное значение: продажи вполне могут поменять канал у
  // двух разных источников подряд, не дожидаясь первого PUT. Одиночный
  // `savingSource: string | null` сбросил бы «заблокирован» у первой строки,
  // как только стартует сохранение второй — блокировка молча исчезла бы для
  // ещё не сохранённой строки.
  const [savingSources, setSavingSources] = useState<Set<string>>(new Set());
  const [savedFlashSources, setSavedFlashSources] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const run = async () => {
      setLoading(true);
      try {
        const res = await authFetch('/api/analytics/first-sales/source-map');
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { rows: SourceMapRow[] };
        if (!active) return;
        setError(null);
        setRows(json.rows);
      } catch (e) {
        if (!active) return;
        logError('first-sales.source_map.fetch_failed', e);
        setError(e instanceof Error ? e.message : 'Не удалось загрузить справочник');
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, []);

  const changeChannel = async (row: SourceMapRow, channel: FirstSalesChannel) => {
    if (channel === row.channel) return;
    const previous = row.channel;
    setSavingSources((cur) => new Set(cur).add(row.source));
    setError(null);
    // Оптимистично обновляем select сразу — иначе на время запроса он держит
    // старое значение, и клик выглядит проигнорированным.
    setRows((cur) => (cur ? cur.map((r) => (r.source === row.source ? { ...r, channel } : r)) : cur));

    try {
      const res = await authFetch('/api/analytics/first-sales/source-map', {
        method: 'PUT',
        body: JSON.stringify({ source: row.source, channel, display_name: row.display_name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setSavedFlashSources((cur) => new Set(cur).add(row.source));
      setTimeout(() => {
        setSavedFlashSources((cur) => {
          if (!cur.has(row.source)) return cur;
          const next = new Set(cur);
          next.delete(row.source);
          return next;
        });
      }, 1800);
      // Дашборд выше сразу пересчитается по новой раскладке — это ожидаемо
      // (пользователь только что сам поменял канал), но чтобы это не читалось
      // как «цифры поехали сами», рядом с селектом даём короткое «Сохранено»,
      // а не молча меняем KPI без обратной связи в самом справочнике.
      onSaved();
    } catch (e) {
      // Откатываем select к прежнему значению — пользователь должен видеть,
      // что сохранение не прошло, а не считать, что канал сменился.
      setRows((cur) => (cur ? cur.map((r) => (r.source === row.source ? { ...r, channel: previous } : r)) : cur));
      logError('first-sales.source_map.save_failed', e, { source: row.source, channel });
      setError(e instanceof Error ? e.message : 'Не удалось сохранить канал');
    } finally {
      setSavingSources((cur) => {
        if (!cur.has(row.source)) return cur;
        const next = new Set(cur);
        next.delete(row.source);
        return next;
      });
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-zinc-200 bg-white px-3 py-6 text-center text-sm text-zinc-400">Загрузка справочника…</div>;
  }

  const sorted = rows ? sortRows(rows) : [];
  const unassignedCount = sorted.filter((r) => r.channel === 'unassigned').length;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-zinc-800">Справочник источников</h2>
        <p className="text-xs text-zinc-500">
          Свёртка значения «Источник» из AMO в канал продаж. Изменение канала сразу пересчитывает сводку, график и
          таблицу источников выше — это ожидаемо, а не сбой.
          {unassignedCount > 0 && (
            <>
              {' '}
              <span className="font-medium text-amber-700">Не распределено: {unassignedCount}.</span>
            </>
          )}
        </p>
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-100">
        <table className="w-full min-w-[420px] text-xs">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-3 py-2 font-medium">Источник</th>
              <th className="px-3 py-2 font-medium">Канал</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const unassigned = row.channel === 'unassigned';
              return (
                <tr
                  key={row.source}
                  className={`border-b border-zinc-50 last:border-0 ${unassigned ? 'bg-amber-50/60' : ''}`}
                >
                  <td className="px-3 py-2">
                    <span className={`font-medium ${unassigned ? 'text-amber-800' : 'text-zinc-800'}`}>
                      {row.display_name || row.source}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={row.channel}
                      disabled={savingSources.has(row.source)}
                      onChange={(e) => void changeChannel(row, e.target.value as FirstSalesChannel)}
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 disabled:opacity-50"
                    >
                      {FIRST_SALES_CHANNELS.map((channel) => (
                        <option key={channel} value={channel}>
                          {CHANNEL_LABELS[channel]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    {savingSources.has(row.source) ? (
                      <span className="text-zinc-400">Сохранение…</span>
                    ) : savedFlashSources.has(row.source) ? (
                      <span className="text-emerald-600">Сохранено</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-zinc-400">
                  Справочник пуст.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
