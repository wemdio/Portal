import type { BenchJobTool } from './types';

interface Scopable {
  eq: (column: string, value: unknown) => Scopable;
}

/**
 * Применяет разграничение инструмента к запросу по таблице задач.
 *
 * HH, ATS и англоязычный найм делят таблицу `parser_jobs`. Без этого фильтра
 * «покажи мои задачи HH» вернуло бы и ATS-задачи, а `GET /jobs/{id}?tool=hh`
 * по идентификатору ATS-задачи выдал бы её как HH-задачу — с чужим смыслом
 * полей и чужой таблицей результатов.
 *
 * Единственная функция на все роуты: разойтись в этой мелочи между четырьмя
 * местами слишком легко, а ошибка тихая.
 */
export function applyToolScope<T extends Scopable>(query: T, tool: BenchJobTool): T {
  if (!tool.scope) return query;
  return query.eq(tool.scope.column, tool.scope.value) as T;
}
