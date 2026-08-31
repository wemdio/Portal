import { z } from 'zod';
import type { BenchSearchPage, BenchSearchTool } from '../types';

const TABLE = 'pdl_companies';
const SELECT = 'id, name, country, industry, size, website, linkedin_url';

// Фильтры повторяют те, что портал предлагает в поиске по базе компаний
// (см. app/src/app/api/company-base/search/route.ts): списковые country /
// industry / size и подстрока по имени.
const filtersSchema = z
  .object({
    country: z.array(z.string().min(1).max(100)).max(50).optional(),
    industry: z.array(z.string().min(1).max(100)).max(50).optional(),
    size: z.array(z.string().min(1).max(50)).max(20).optional(),
    name: z.string().min(2).max(200).optional(),
  })
  .strict();

type Filters = z.infer<typeof filtersSchema>;

interface FilterableQuery {
  in: (column: string, values: string[]) => FilterableQuery;
  ilike: (column: string, pattern: string) => FilterableQuery;
}

/**
 * `%` и `_` в пользовательской строке — подстановочные знаки LIKE. Без
 * вырезания запрос `name: "%"` означает «все 13 млн строк», то есть один
 * символ превращается в выгрузку всей базы мимо любых фильтров. Портал
 * вырезает их так же.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_]/g, '');
}

function applyFilters<T extends FilterableQuery>(query: T, filters: Filters): T {
  let q = query;
  if (filters.country?.length) q = q.in('country', filters.country) as T;
  if (filters.industry?.length) q = q.in('industry', filters.industry) as T;
  if (filters.size?.length) q = q.in('size', filters.size) as T;
  if (filters.name) q = q.ilike('name', `%${escapeLike(filters.name)}%`) as T;
  return q;
}

export const companyBaseTool: BenchSearchTool = {
  id: 'company-base',
  kind: 'search',
  title: 'Наша база компаний',
  filtersSchema,

  // Курсор — id последней отданной строки, а не смещение. В таблице 13 млн
  // строк: `offset` на глубоких страницах заставляет Postgres прочитать и
  // выбросить всё до смещения, а на растущей таблице ещё и теряет строки
  // между страницами.
  async run({ db, filters, limit, cursor }): Promise<BenchSearchPage> {
    const parsed = filters as Filters;

    let query = db
      .from(TABLE)
      .select(SELECT)
      .order('id', { ascending: true })
      .limit(limit);
    query = applyFilters(query as unknown as FilterableQuery, parsed) as never;
    if (cursor) query = (query as unknown as { gt: (c: string, v: string) => never }).gt('id', cursor);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const hasMore = rows.length === limit;
    const last = rows[rows.length - 1];
    return {
      rows,
      cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    };
  },
};
