import { z } from 'zod';
import type { BenchSearchPage, BenchSearchTool } from '../types';

const TABLE = 'pdl_companies';
const SELECT = 'id, name, country, industry, size, website, linkedin_url';
const NAME_SEARCH_RPC = 'search_pdl_companies';

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

function applyListFilters<T extends FilterableQuery>(query: T, filters: Filters): T {
  let q = query;
  if (filters.country?.length) q = q.in('country', filters.country) as T;
  if (filters.industry?.length) q = q.in('industry', filters.industry) as T;
  if (filters.size?.length) q = q.in('size', filters.size) as T;
  return q;
}

type BenchDb = Parameters<BenchSearchTool['run']>[0]['db'];

/**
 * Поиск по имени — через RPC search_pdl_companies, а не `ilike` по таблице.
 *
 * После 20261015_0033 на pdl_companies стоит RLS-шлюз
 * (is_internal_staff() or is_api_robot()). Оператор `~~*` не leakproof, поэтому
 * планировщик не вправе проверить `name ilike '%x%'` раньше условия RLS и не
 * берёт триграммный индекс idx_pdl_companies_name_trgm: запрос робота уходил бы
 * в полный проход 19,5 млн строк. RPC с 0033 — SECURITY DEFINER со своей
 * проверкой вызывающего (робот Bench допущен через is_api_robot()) и
 * планируется так же, как до шлюза. До 0033 и после его отката она SECURITY
 * INVOKER и читает таблицу правами робота, как прямой запрос.
 *
 * Фильтры country/industry/size — равенства (`= any`), те же, что у `.in()`,
 * регистр не меняется. Порядок по id, курсор «id больше последнего» и лимит —
 * как у прямого чтения.
 *
 * Разрыв: RPC не отдаёт linkedin_url. Форма строки та же, но в ответе поиска
 * по имени linkedin_url всегда null; без имени поле приходит из таблицы.
 */
async function searchByName(
  db: BenchDb,
  filters: Filters,
  name: string,
  limit: number,
  cursor: string | null,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await db.rpc(NAME_SEARCH_RPC, {
    p_industries: filters.industry?.length ? filters.industry : null,
    p_sizes: filters.size?.length ? filters.size : null,
    p_countries: filters.country?.length ? filters.country : null,
    p_name: name,
    p_after_id: cursor,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) throw new Error(`${NAME_SEARCH_RPC} returned a non-array response`);
  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    name: row.name ?? null,
    country: row.country ?? null,
    industry: row.industry ?? null,
    size: row.size ?? null,
    website: row.website ?? null,
    linkedin_url: null,
  }));
}

export const companyBaseTool: BenchSearchTool = {
  id: 'company-base',
  kind: 'search',
  title: 'Наша база компаний',
  // Общий справочник: у строк pdl_companies нет владельца, все внутренние
  // пользователи видят одно и то же. Читаем клиентом робота — той же
  // дорогой, что и живой сотрудник.
  access: 'robot',
  filtersSchema,

  // Курсор — id последней отданной строки, а не смещение. В таблице 13 млн
  // строк: `offset` на глубоких страницах заставляет Postgres прочитать и
  // выбросить всё до смещения, а на растущей таблице ещё и теряет строки
  // между страницами.
  async run({ db, filters, limit, cursor }): Promise<BenchSearchPage> {
    const parsed = filters as Filters;
    // Имя из одних `%`/`_` после вырезания пустое: это не поиск по имени.
    const name = parsed.name ? escapeLike(parsed.name) : '';

    let rows: Array<Record<string, unknown>>;
    if (name) {
      rows = await searchByName(db, parsed, name, limit, cursor);
    } else {
      let query = db
        .from(TABLE)
        .select(SELECT)
        .order('id', { ascending: true })
        .limit(limit);
      query = applyListFilters(query as unknown as FilterableQuery, parsed) as never;
      if (cursor) query = (query as unknown as { gt: (c: string, v: string) => never }).gt('id', cursor);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      rows = (data ?? []) as Array<Record<string, unknown>>;
    }

    const hasMore = rows.length === limit;
    const last = rows[rows.length - 1];
    return {
      rows,
      cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    };
  },
};
