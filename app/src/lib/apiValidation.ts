export type UpdatePrecondition = {
  expectedUpdatedAt: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function pickInputValue(
  body: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): { present: boolean; value: unknown } {
  if (hasOwn(body, camelKey)) return { present: true, value: body[camelKey] };
  if (hasOwn(body, snakeKey)) return { present: true, value: body[snakeKey] };
  return { present: false, value: undefined };
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

export function isValidRfc3339Timestamp(value: string): boolean {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match || !isValidIsoDate(match[1])) return false;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[7] ? Number(match[7]) : 0;
  const offsetMinute = match[8] ? Number(match[8]) : 0;

  return (
    hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 14
    && offsetMinute <= 59
    && (offsetHour < 14 || offsetMinute === 0)
    && Number.isFinite(Date.parse(value))
  );
}

export function parseUpdatePrecondition(
  value: unknown,
): { value: UpdatePrecondition } | { error: 'missing' | 'invalid' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'invalid' };
  }

  const field = pickInputValue(
    value as Record<string, unknown>,
    'expectedUpdatedAt',
    'expected_updated_at',
  );
  if (!field.present) return { error: 'missing' };
  if (
    typeof field.value !== 'string'
    || !isValidRfc3339Timestamp(field.value)
  ) {
    return { error: 'invalid' };
  }

  return { value: { expectedUpdatedAt: field.value } };
}
