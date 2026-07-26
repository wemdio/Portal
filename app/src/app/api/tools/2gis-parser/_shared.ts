import { normalizeTwoGisFilters } from '@/lib/twoGis/query';

const ARRAY_FILTER_KEYS = ['cities', 'categories', 'subcategories'] as const;
const BOOLEAN_FILTER_KEYS = [
  'hasPhone',
  'hasEmail',
  'hasWebsite',
  'hasVkontakte',
  'hasInstagram',
] as const;
const ALLOWED_FILTER_KEYS = new Set<string>([
  ...ARRAY_FILTER_KEYS,
  ...BOOLEAN_FILTER_KEYS,
  'name',
]);

const MAX_FILTER_VALUES = 200;
const MAX_FILTER_VALUE_LENGTH = 300;

export class TwoGisRequestError extends Error {}

export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new TwoGisRequestError('Invalid JSON');
  }

  if (!isRecord(value)) {
    throw new TwoGisRequestError('Request body must be an object');
  }
  return value;
}

export function parseTwoGisFilters(
  value: unknown,
): ReturnType<typeof normalizeTwoGisFilters> {
  if (value === undefined) return normalizeTwoGisFilters({});
  if (!isRecord(value)) {
    throw new TwoGisRequestError('filters must be an object');
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_FILTER_KEYS.has(key)) {
      throw new TwoGisRequestError(`Unsupported filter: ${key}`);
    }
  }

  for (const key of ARRAY_FILTER_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (
      !Array.isArray(candidate)
      || candidate.length > MAX_FILTER_VALUES
      || candidate.some(
        (item) =>
          typeof item !== 'string'
          || item.length > MAX_FILTER_VALUE_LENGTH,
      )
    ) {
      throw new TwoGisRequestError(
        `${key} must be an array of short strings`,
      );
    }
  }

  for (const key of BOOLEAN_FILTER_KEYS) {
    const candidate = value[key];
    if (candidate !== undefined && typeof candidate !== 'boolean') {
      throw new TwoGisRequestError(`${key} must be a boolean`);
    }
  }

  if (
    value.name !== undefined
    && (
      typeof value.name !== 'string'
      || value.name.length > MAX_FILTER_VALUE_LENGTH
    )
  ) {
    throw new TwoGisRequestError('name must be a short string');
  }

  const normalized = normalizeTwoGisFilters(
    value as Parameters<typeof normalizeTwoGisFilters>[0],
  );
  if (normalized.name && normalized.name.length < 3) {
    throw new TwoGisRequestError(
      'name must contain at least 3 non-whitespace characters',
    );
  }
  return normalized;
}

export function parsePreviewLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 1
  ) {
    throw new TwoGisRequestError('limit must be a positive integer');
  }
  return Math.min(value, 200);
}

export function parseCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string'
    || value.length > MAX_FILTER_VALUE_LENGTH
  ) {
    throw new TwoGisRequestError('cursor must be a short string');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
