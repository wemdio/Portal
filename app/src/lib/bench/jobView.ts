import type { BenchJobTool, BenchJobView, JobRow } from './types';

/**
 * Наружу отдаём только перечисленные поля.
 *
 * Строка таблицы задач содержит `user_id`, зашифрованные реквизиты прокси и
 * внутренний `config`. Поэтому представление собирается перечислением, а НЕ
 * копированием строки: при копировании любое новое внутреннее поле утекало
 * бы наружу само собой, тихо и с ближайшей миграцией.
 */
export function toBenchJobView(tool: BenchJobTool, row: JobRow): BenchJobView {
  return {
    id: String(row.id),
    tool: tool.id,
    status: tool.mapStatus(row),
    progress: tool.progress(row),
    rows_found: tool.rowsFound(row),
    error: tool.errorOf(row),
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
    finished_at: tool.finishedAt(row),
  };
}
