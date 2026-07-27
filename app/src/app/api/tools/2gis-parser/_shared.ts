import { normalizeTwoGisFilters } from '@/lib/twoGis/query';
import { TWO_GIS_MAX_FILTER_VALUES } from '@/lib/twoGis/types';

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
  'rubricGroups',
]);

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
      || candidate.length > TWO_GIS_MAX_FILTER_VALUES
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

  const rubricGroups = value.rubricGroups;
  if (rubricGroups !== undefined) {
    if (!Array.isArray(rubricGroups)) {
      throw new TwoGisRequestError('rubricGroups must be an array');
    }
    if (rubricGroups.length > TWO_GIS_MAX_FILTER_VALUES) {
      throw new TwoGisRequestError(
        `rubricGroups cannot contain more than ${TWO_GIS_MAX_FILTER_VALUES} selections`,
      );
    }
    if (value.categories !== undefined || value.subcategories !== undefined) {
      throw new TwoGisRequestError(
        'rubricGroups cannot be combined with categories or subcategories',
      );
    }

    let selectionCount = 0;
    const categories = new Set<string>();
    for (const group of rubricGroups) {
      if (!isRecord(group)) {
        throw new TwoGisRequestError('rubricGroups must contain objects');
      }
      let allowedKeys: Set<string>;
      if (group.mode === 'all') {
        allowedKeys = new Set(['category', 'mode']);
      } else if (group.mode === 'some') {
        allowedKeys = new Set(['category', 'mode', 'subcategories']);
      } else if (group.mode === 'allExcept') {
        allowedKeys = new Set([
          'category',
          'mode',
          'excludedSubcategories',
        ]);
      } else {
        throw new TwoGisRequestError(
          'rubricGroups mode must be all, some or allExcept',
        );
      }
      if (Object.keys(group).some((key) => !allowedKeys.has(key))) {
        throw new TwoGisRequestError('rubricGroups contains unsupported fields');
      }
      if (
        typeof group.category !== 'string'
        || !group.category.trim()
        || group.category.length > MAX_FILTER_VALUE_LENGTH
      ) {
        throw new TwoGisRequestError(
          'rubricGroups must contain short strings',
        );
      }
      const normalizedCategory = group.category.trim();
      if (categories.has(normalizedCategory)) {
        throw new TwoGisRequestError(
          'rubricGroups must contain unique categories',
        );
      }
      categories.add(normalizedCategory);

      if (group.mode === 'all') {
        selectionCount += 1;
      } else if (group.mode === 'some') {
        if (
          Array.isArray(group.subcategories)
          && group.subcategories.length > TWO_GIS_MAX_FILTER_VALUES
        ) {
          throw new TwoGisRequestError(
            `rubricGroups cannot contain more than ${TWO_GIS_MAX_FILTER_VALUES} selections`,
          );
        }
        if (
          !Array.isArray(group.subcategories)
          || group.subcategories.length === 0
          || group.subcategories.some(
            (item) =>
              typeof item !== 'string'
              || !item.trim()
              || item.length > MAX_FILTER_VALUE_LENGTH,
          )
        ) {
          throw new TwoGisRequestError(
            'rubricGroups must contain arrays of short strings',
          );
        }
        selectionCount += group.subcategories.length;
      } else if (group.mode === 'allExcept') {
        if (
          Array.isArray(group.excludedSubcategories)
          && group.excludedSubcategories.length
            > TWO_GIS_MAX_FILTER_VALUES - 1
        ) {
          throw new TwoGisRequestError(
            `rubricGroups cannot contain more than ${TWO_GIS_MAX_FILTER_VALUES} selections`,
          );
        }
        if (
          !Array.isArray(group.excludedSubcategories)
          || group.excludedSubcategories.length === 0
          || group.excludedSubcategories.some(
            (item) =>
              typeof item !== 'string'
              || !item.trim()
              || item.length > MAX_FILTER_VALUE_LENGTH,
          )
        ) {
          throw new TwoGisRequestError(
            'rubricGroups must contain arrays of short strings',
          );
        }
        selectionCount += 1 + group.excludedSubcategories.length;
      }

      if (selectionCount > TWO_GIS_MAX_FILTER_VALUES) {
        throw new TwoGisRequestError(
          `rubricGroups cannot contain more than ${TWO_GIS_MAX_FILTER_VALUES} selections`,
        );
      }
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
