import { TWO_GIS_SOURCE_COLUMNS, type TwoGisFilters, type TwoGisQuery } from './types';

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

export function normalizeTwoGisFilters(input: TwoGisFilters | Record<string, unknown>): TwoGisFilters {
  const normalized: TwoGisFilters = {};
  const cities = normalizeList(input.cities);
  const categories = normalizeList(input.categories);
  const subcategories = normalizeList(input.subcategories);
  if (cities) normalized.cities = cities;
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

function buildWhere(
  filters: TwoGisFilters,
  cursor?: string,
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.cities?.length) {
    clauses.push(`city_name = ANY(${addParam(filters.cities)}::text[])`);
  }
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
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

export function buildTwoGisCountQuery(filters: TwoGisFilters): TwoGisQuery {
  const where = buildWhere(filters);
  return {
    text: `SELECT count(*)::bigint AS count FROM public.cards AS cards${where.sql}`,
    params: where.params,
  };
}

export function buildTwoGisSearchQuery(
  filters: TwoGisFilters,
  options: { limit?: number; cursor?: string } = {},
): TwoGisQuery {
  const where = buildWhere(filters, options.cursor);
  const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 100;
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_PREVIEW_LIMIT);
  const params = [...where.params, limit];
  return {
    text:
      `SELECT ${TWO_GIS_SOURCE_COLUMNS.join(', ')} FROM public.cards AS cards`
      + `${where.sql} ORDER BY id ASC LIMIT $${params.length}`,
    params,
  };
}

export function buildTwoGisExportBatchQuery(
  filters: TwoGisFilters,
  options: { batchSize?: number; cursor?: string } = {},
): TwoGisQuery {
  const where = buildWhere(filters, options.cursor);
  const requested = Number.isFinite(options.batchSize) ? Number(options.batchSize) : 5_000;
  const batchSize = Math.min(Math.max(Math.trunc(requested), 1), MAX_EXPORT_BATCH_SIZE);
  const params = [...where.params, batchSize];
  return {
    text:
      `SELECT ${TWO_GIS_SOURCE_COLUMNS.join(', ')} FROM public.cards AS cards`
      + `${where.sql} ORDER BY id ASC LIMIT $${params.length}`,
    params,
  };
}
