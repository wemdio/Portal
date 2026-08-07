'use client';

import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import RenewalsRowsTable from '@/components/renewals/RenewalsRowsTable';

/**
 * Основной вид дашборда — таблица, а не график: продлений всего 32 за всю
 * историю, и список, где видно каждое, полезнее двух-трёх столбиков на
 * графике (см. план дашборда). Строки срезаны тем же периодом, что и плитки:
 * страница фильтруется целиком.
 *
 * Каждая колонка кликабельна для сортировки (см. RenewalsRowsTable и общий
 * механизм в `@/components/ui/useSortableRows`): возрастание → убывание →
 * исходный порядок «свежие сверху», в котором строки уже приходят от
 * `buildRenewalTableRows`.
 *
 * Продления без даты оплаты в эту таблицу не попадают ни при каком периоде:
 * привязать их ко времени не к чему. Раньше здесь была только сноска с их
 * числом — теперь под таблицей стоит `RenewalsUndatedSection`, отдельный
 * сворачиваемый блок с самими строками (см. RenewalsView.tsx).
 */
export default function RenewalsTable({ rows }: { rows: RenewalTableRow[] }) {
  return (
    <div className="glass-frame overflow-x-auto">
      <RenewalsRowsTable rows={rows} emptyMessage="Нет продлений, подходящих под фильтр." />
    </div>
  );
}
