/**
 * Чтение прогона английского аутрича целиком через ручку результатов
 * (api/parsers/polza-outreach/[jobId]/results) — страницами.
 *
 * Ручка отдаёт за раз не больше POLZA_RESULTS_MAX_PAGE строк, а прогон бывает
 * больше: запуск на 500 готовых просматривает до 4000 кандидатов. Окно разбора
 * этапа читало одну страницу в тысячу строк и молча показывало часть прогона —
 * числа в окне расходились с цепочкой этапов. Порядок строк на странице
 * стабильный (created_at, затем id): строки одной вставки делят created_at,
 * и без второго ключа страницы могли бы повторять и терять строки.
 *
 * Модуль без зависимостей: его импортирует и клиентский экран.
 */

/** Потолок страницы ручки результатов — и размер страницы, которой экран читает прогон целиком. */
export const POLZA_RESULTS_MAX_PAGE = 1000;

export interface ResultsPage<T> {
  items: T[];
  /** Сколько строк всего под этим фильтром (count ручки). */
  count: number;
}

/**
 * Все строки по страницам: offset растёт на число полученных строк. Стоп —
 * короткая страница (ручка отдаёт ровно limit, пока строк хватает) или offset
 * дошёл до count. Пустая страница — тоже короткая: бесконечного цикла нет, даже
 * если count устарел, пока идёт запуск.
 */
export async function fetchAllResultPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<ResultsPage<T>>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; ) {
    const page = await fetchPage(offset, POLZA_RESULTS_MAX_PAGE);
    all.push(...page.items);
    offset += page.items.length;
    onProgress?.(offset, Math.max(offset, page.count));
    if (page.items.length < POLZA_RESULTS_MAX_PAGE || offset >= page.count) return all;
  }
}
