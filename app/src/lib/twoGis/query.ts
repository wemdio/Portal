import {
  TWO_GIS_SOURCE_COLUMNS,
  type TwoGisFilters,
  type TwoGisQuery,
  type TwoGisRubricGroup,
} from './types';

const MAX_PREVIEW_LIMIT = 200;
const MAX_EXPORT_BATCH_SIZE = 10_000;

function normalizeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRubricGroups(value: unknown): TwoGisRubricGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const groupsByCategory = new Map<string, TwoGisRubricGroup>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.category !== 'string') continue;
    const category = item.category.trim();
    if (!category) continue;

    if (item.mode === 'all') {
      groupsByCategory.set(category, { category, mode: 'all' });
      continue;
    }
    if (item.mode === 'allExcept') {
      const excludedSubcategories = normalizeList(
        item.excludedSubcategories,
      );
      if (!excludedSubcategories) {
        groupsByCategory.set(category, { category, mode: 'all' });
        continue;
      }
      if (groupsByCategory.get(category)?.mode !== 'all') {
        groupsByCategory.set(category, {
          category,
          mode: 'allExcept',
          excludedSubcategories,
        });
      }
      continue;
    }
    if (item.mode !== 'some') continue;

    const subcategories = normalizeList(item.subcategories);
    if (!subcategories || groupsByCategory.get(category)?.mode === 'all') {
      continue;
    }
    const existing = groupsByCategory.get(category);
    groupsByCategory.set(category, {
      category,
      mode: 'some',
      subcategories: normalizeList([
        ...(existing?.mode === 'some' ? existing.subcategories : []),
        ...subcategories,
      ]) ?? [],
    });
  }

  const groups = [...groupsByCategory.values()].filter(
    (group) =>
      group.mode === 'all'
      || (
        group.mode === 'some'
          ? group.subcategories.length > 0
          : group.excludedSubcategories.length > 0
      ),
  );
  return groups.length > 0 ? groups : undefined;
}

export function normalizeTwoGisFilters(input: TwoGisFilters | Record<string, unknown>): TwoGisFilters {
  const normalized: TwoGisFilters = {};
  const cities = normalizeList(input.cities);
  const rubricGroups = normalizeRubricGroups(input.rubricGroups);
  const categories = normalizeList(input.categories);
  const subcategories = normalizeList(input.subcategories);
  if (cities) normalized.cities = cities;
  if (rubricGroups) normalized.rubricGroups = rubricGroups;
  if (categories) normalized.categories = categories;
  if (subcategories) normalized.subcategories = subcategories;

  if (typeof input.name === 'string' && input.name.trim()) {
    normalized.name = input.name.trim();
  }

  for (const key of [
    'hasPhone',
    'hasEmail',
    'hasWebsite',
    'hasVkontakte',
    'hasInstagram',
  ] as const) {
    if (typeof input[key] === 'boolean') normalized[key] = input[key];
  }

  return normalized;
}

function buildQueryParts(
  filters: TwoGisFilters,
  cursor?: string,
): { joinSql: string; whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let joinSql = '';

  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.rubricGroups?.length) {
    const wholeCategories = filters.rubricGroups.flatMap((group) =>
      group.mode === 'all' ? [group.category] : [],
    );
    const partialCategories: string[] = [];
    const partialSubcategories: string[] = [];
    const exceptCategories: string[] = [];
    const excludedCategories: string[] = [];
    const excludedSubcategories: string[] = [];
    for (const group of filters.rubricGroups) {
      if (group.mode === 'some') {
        for (const subcategory of group.subcategories) {
          partialCategories.push(group.category);
          partialSubcategories.push(subcategory);
        }
      } else if (group.mode === 'allExcept') {
        exceptCategories.push(group.category);
        for (const subcategory of group.excludedSubcategories) {
          excludedCategories.push(group.category);
          excludedSubcategories.push(subcategory);
        }
      }
    }

    const rubricMatches: string[] = [];
    if (wholeCategories.length > 0) {
      rubricMatches.push(
        `SELECT category_card.id AS card_id
         FROM public.cards AS category_card
         WHERE category_card.category = ANY(${addParam(wholeCategories)}::text[])`,
      );
    }
    if (partialCategories.length > 0) {
      const categoriesParam = addParam(partialCategories);
      const subcategoriesParam = addParam(partialSubcategories);
      rubricMatches.push(
        `SELECT DISTINCT card_subcategory.card_id
         FROM public.card_subcategories AS card_subcategory
         JOIN unnest(
           ${categoriesParam}::text[],
           ${subcategoriesParam}::text[]
         ) AS selected_rubric(category, value)
           ON selected_rubric.category = card_subcategory.category
          AND selected_rubric.value = card_subcategory.value`,
      );
    }
    if (exceptCategories.length > 0) {
      const exceptCategoriesParam = addParam(exceptCategories);
      const excludedCategoriesParam = addParam(excludedCategories);
      const excludedSubcategoriesParam = addParam(excludedSubcategories);
      rubricMatches.push(
        `SELECT remaining_category_card.card_id
         FROM (
           SELECT included_category_card.id AS card_id
           FROM public.cards AS included_category_card
           WHERE included_category_card.category = ANY(${exceptCategoriesParam}::text[])
           EXCEPT
           SELECT excluded_only_card.card_id
           FROM (
             SELECT excluded_card_subcategory.card_id
             FROM public.card_subcategories AS excluded_card_subcategory
             JOIN unnest(
               ${excludedCategoriesParam}::text[],
               ${excludedSubcategoriesParam}::text[]
             ) AS excluded_rubric(category, value)
               ON excluded_rubric.category = excluded_card_subcategory.category
              AND excluded_rubric.value = excluded_card_subcategory.value
             EXCEPT
             SELECT allowed_card_subcategory.card_id
             FROM public.card_subcategories AS allowed_card_subcategory
             LEFT JOIN unnest(
               ${excludedCategoriesParam}::text[],
               ${excludedSubcategoriesParam}::text[]
             ) AS excluded_rubric_for_allowed(category, value)
               ON excluded_rubric_for_allowed.category = allowed_card_subcategory.category
              AND excluded_rubric_for_allowed.value = allowed_card_subcategory.value
             WHERE allowed_card_subcategory.category = ANY(${exceptCategoriesParam}::text[])
               AND excluded_rubric_for_allowed.value IS NULL
           ) AS excluded_only_card
         ) AS remaining_category_card`,
      );
    }
    if (rubricMatches.length > 0) {
      joinSql =
        ` JOIN (${rubricMatches.join('\nUNION\n')}) AS rubric_match`
        + ' ON rubric_match.card_id = cards.id';
    }
  } else {
    if (filters.categories?.length) {
      clauses.push(`category = ANY(${addParam(filters.categories)}::text[])`);
    }
    if (filters.subcategories?.length) {
      clauses.push(
        `EXISTS (
          SELECT 1
          FROM public.card_subcategories
          WHERE card_subcategories.card_id = cards.id
            AND card_subcategories.value = ANY(${addParam(filters.subcategories)}::text[])
        )`,
      );
    }
  }
  if (filters.cities?.length) {
    clauses.push(`city_name = ANY(${addParam(filters.cities)}::text[])`);
  }
  if (filters.name) {
    const escaped = filters.name.replace(/[\\%_]/g, '\\$&');
    clauses.push(`name ILIKE ${addParam(`%${escaped}%`)} ESCAPE '\\'`);
  }
  if (filters.hasPhone) clauses.push('has_phone = true');
  if (filters.hasEmail) clauses.push('has_email = true');
  if (filters.hasWebsite) clauses.push('has_website = true');
  if (filters.hasVkontakte) clauses.push('has_vkontakte = true');
  if (filters.hasInstagram) clauses.push('has_instagram = true');
  if (cursor) clauses.push(`id > ${addParam(cursor)}`);

  return {
    joinSql,
    whereSql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

export function buildTwoGisCountQuery(filters: TwoGisFilters): TwoGisQuery {
  const parts = buildQueryParts(filters);
  return {
    text:
      'SELECT count(*)::bigint AS count FROM public.cards AS cards'
      + `${parts.joinSql}${parts.whereSql}`,
    params: parts.params,
  };
}

export function buildTwoGisSearchQuery(
  filters: TwoGisFilters,
  options: { limit?: number; cursor?: string } = {},
): TwoGisQuery {
  const parts = buildQueryParts(filters, options.cursor);
  const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 100;
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_PREVIEW_LIMIT);
  const params = [...parts.params, limit];
  return {
    text:
      `SELECT ${TWO_GIS_SOURCE_COLUMNS.join(', ')} FROM public.cards AS cards`
      + `${parts.joinSql}${parts.whereSql} ORDER BY id ASC`
      + ` LIMIT $${params.length}`,
    params,
  };
}

export function buildTwoGisExportBatchQuery(
  filters: TwoGisFilters,
  options: { batchSize?: number; cursor?: string } = {},
): TwoGisQuery {
  const parts = buildQueryParts(filters, options.cursor);
  const requested = Number.isFinite(options.batchSize) ? Number(options.batchSize) : 5_000;
  const batchSize = Math.min(Math.max(Math.trunc(requested), 1), MAX_EXPORT_BATCH_SIZE);
  const params = [...parts.params, batchSize];
  return {
    text:
      `SELECT ${TWO_GIS_SOURCE_COLUMNS.join(', ')} FROM public.cards AS cards`
      + `${parts.joinSql}${parts.whereSql} ORDER BY id ASC`
      + ` LIMIT $${params.length}`,
    params,
  };
}
