'use client';

import { CHANNEL_LABELS } from '@/lib/firstSales/sourceChannels';
import type { SourceBreakdown } from '@/lib/firstSales/metrics';

const fmt = (n: number) => n.toLocaleString('ru-RU');
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '—');

export default function SourceTable({ rows }: { rows: SourceBreakdown[] }) {
  const totalLeads = rows.reduce((sum, r) => sum + r.leads, 0);

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
          {rows.map((row) => (
            <tr key={row.source} className="border-b border-zinc-50 hover:bg-zinc-50/60">
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
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
          ))}
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
