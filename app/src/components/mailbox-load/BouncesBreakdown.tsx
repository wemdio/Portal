'use client';

type Row = { key: string; bounced: number };
export type Breakdown = {
  day: string;
  total: number;
  mailboxes: Row[];
  campaigns: Row[];
  steps: Row[];
  domains: Row[];
};

const SECTIONS: Array<{ key: 'mailboxes' | 'campaigns' | 'steps' | 'domains'; title: string; hint: string }> = [
  { key: 'mailboxes', title: 'По ящикам', hint: 'С какого ящика уходит больше всего отбоев' },
  { key: 'campaigns', title: 'По кампаниям', hint: 'Где в списке доля отбоев выше' },
  { key: 'steps', title: 'По шагам цепочки', hint: 'На каком письме отбивает: первое — мёртвый адрес' },
  { key: 'domains', title: 'По доменам получателей', hint: 'Какие почтовые сервисы отбивают' },
];

const nf = (n: number) => n.toLocaleString('ru-RU');

/** Данные приходят готовыми от страницы (грузятся параллельно с таблицей ящиков). */
export default function BouncesBreakdown({ data, error }: { data: Breakdown | null; error: string | null }) {
  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">Не удалось посчитать отбои: {error}</div>;
  }
  if (!data) return null;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-sm font-semibold text-zinc-900">Отбои за день: кто и где</div>
        <div className="text-xs text-zinc-500">всего {nf(data.total)} · причины отказа Instantly не отдаёт</div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <div key={s.key}>
            <div className="text-xs font-medium text-zinc-700">{s.title}</div>
            <div className="mb-1 text-[11px] text-zinc-400">{s.hint}</div>
            {data[s.key].length === 0 ? (
              <div className="text-xs text-zinc-400">нет данных</div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {data[s.key].map((r) => (
                    <tr key={r.key} className="border-t border-zinc-100">
                      <td className="break-all py-1 pr-2 text-zinc-700">{r.key}</td>
                      <td className="py-1 text-right tabular-nums text-zinc-900">{nf(r.bounced)}</td>
                      <td className="py-1 pl-2 text-right tabular-nums text-zinc-400">
                        {data.total ? `${Math.round((r.bounced / data.total) * 100)}%` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
