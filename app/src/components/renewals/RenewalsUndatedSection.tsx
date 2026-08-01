'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import RenewalsRowsTable from '@/components/renewals/RenewalsRowsTable';

/**
 * Продления без распознанной даты оплаты — раньше об этом говорила только
 * сноска под таблицей («Ещё N продлений без даты… их не видно…»), сами
 * строки нигде не показывались. Теперь они здесь: те же восемь колонок, та
 * же сортировка (свой независимый экземпляр `RenewalsRowsTable`), но
 * отдельным блоком — период на них не распространяется (см. route.ts,
 * `buildUndatedRenewalTableRows`), поэтому смешивать их со строками
 * основной таблицы, которая живёт внутри периода, было бы неверно.
 *
 * Свёрнут по умолчанию: на дашборде обычно 3-5 таких строк, и, постоянно
 * открытые, они отвлекали бы от чисел периода сильнее, чем сноска-текст,
 * которую они заменяют. Кликабельный заголовок с явным счётчиком и стрелкой
 * — обычный паттерн раскрытия в этом дашборде (см. ChevronDown/ChevronRight
 * в first-sales/SourceTable.tsx), поэтому находится тем же способом, что и
 * drill-down там.
 */
export default function RenewalsUndatedSection({ rows }: { rows: RenewalTableRow[] }) {
  const [open, setOpen] = useState(false);

  if (rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden />
        )}
        <span className="text-xs font-medium text-amber-800">Продления без даты оплаты ({rows.length})</span>
        <span className="text-[11px] text-amber-700">
          — не учтены в обороте и количестве выше: привязать ко времени нечем, период на них не действует.
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-amber-200 bg-white">
          <RenewalsRowsTable rows={rows} emptyMessage="Нет продлений без даты оплаты." />
        </div>
      )}
    </div>
  );
}
