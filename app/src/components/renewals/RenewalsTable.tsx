'use client';

import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import RenewalsRowsTable from '@/components/renewals/RenewalsRowsTable';

/**
 * Основной вид дашборда — таблица подтверждённых продлений за выбранный
 * период, срезанная тем же периодом, что и плитки KPI-ряда (см. route.ts):
 * страница фильтруется целиком, а не по частям.
 *
 * Каждая колонка кликабельна для сортировки (см. RenewalsRowsTable и общий
 * механизм в `@/components/ui/useSortableRows`): возрастание → убывание →
 * исходный порядок «свежие сверху», в котором строки уже приходят от
 * `buildRenewalTableRows`.
 *
 * Кандидаты без решения (ждут разбора человеком) сюда не попадают — они не
 * продления, их количество показывает плитка «Не разобрано» в KpiRow.
 */
export default function RenewalsTable({ rows }: { rows: RenewalTableRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <RenewalsRowsTable rows={rows} emptyMessage="Нет продлений, подтверждённых за этот период." />
    </div>
  );
}
