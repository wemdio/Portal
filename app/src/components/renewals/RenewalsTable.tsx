'use client';

import type { RenewalTableRow } from '@/lib/renewals/tableRows';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

function fmtMoneyCell(value: number | null, raw: string | null) {
  if (value !== null) return `${value.toLocaleString('ru-RU')} ₽`;
  if (raw && raw.trim() !== '') {
    return (
      <span className="text-amber-700" title="Не удалось распознать сумму, показана как в базе">
        {raw}
      </span>
    );
  }
  return '—';
}

function fmtNumberCell(value: number | null, raw: string | null) {
  if (value !== null) return value.toLocaleString('ru-RU');
  if (raw && raw.trim() !== '') {
    return (
      <span className="text-amber-700" title="Не удалось распознать число, показано как в базе">
        {raw}
      </span>
    );
  }
  return '—';
}

/**
 * Основной вид дашборда — таблица, а не график: продлений всего 32 за всю
 * историю, и список, где видно каждое, полезнее двух-трёх столбиков на
 * графике (см. план дашборда). Строки срезаны тем же периодом, что и плитки:
 * страница фильтруется целиком.
 *
 * Цена этого — продления без даты оплаты в таблицу не попадают ни при каком
 * периоде: привязать их ко времени не к чему. Поэтому под таблицей стоит
 * сноска с их числом. Пять строк, исчезнувших с экрана бесследно, — худший
 * исход, чем одна строка пояснения.
 */
export default function RenewalsTable({
  rows,
  withoutDate,
}: {
  rows: RenewalTableRow[];
  withoutDate: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
            <th className="px-3 py-2 font-medium">Клиент</th>
            <th className="px-3 py-2 font-medium">Услуга</th>
            <th className="px-3 py-2 font-medium text-right">Сумма</th>
            <th className="px-3 py-2 font-medium">Дата оплаты</th>
            <th className="px-3 py-2 font-medium">Дата договора</th>
            <th className="px-3 py-2 font-medium text-right">KPI-факт</th>
            <th className="px-3 py-2 font-medium">Статус</th>
            <th className="px-3 py-2 font-medium">Менеджер</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50/60">
              <td className="px-3 py-2 font-medium text-zinc-800">{row.client || '—'}</td>
              <td className="px-3 py-2 text-zinc-600">{row.name || '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                {fmtMoneyCell(row.budget, row.budgetRaw)}
              </td>
              <td className="px-3 py-2 tabular-nums text-zinc-600">
                <div className="flex items-center gap-1.5">
                  {fmtDate(row.paymentDate)}
                  {row.isPlanned && (
                    <span
                      title="Дата оплаты в будущем — это план, не свершившееся продление"
                      className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                    >
                      план
                    </span>
                  )}
                  {row.paymentDate === null && (
                    <span
                      title="Дата оплаты пуста или не в формате YYYY-MM-DD"
                      className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                    >
                      без даты
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 tabular-nums text-zinc-600">{fmtDate(row.contractDate)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                {fmtNumberCell(row.kpiFact, row.kpiFactRaw)}
              </td>
              <td className="px-3 py-2 text-zinc-600">{row.status || '—'}</td>
              <td className="px-3 py-2 text-zinc-600">{row.manager || '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-zinc-400">
                Нет продлений, подходящих под фильтр.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {withoutDate > 0 && (
        <p className="border-t border-zinc-100 px-3 py-2 text-[11px] text-amber-700">
          Ещё {withoutDate} продлений без даты оплаты — их не видно в таблице ни при каком периоде,
          привязать ко времени нечем. В обороте и количестве они тоже не учтены.
        </p>
      )}
    </div>
  );
}
