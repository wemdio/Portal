export type LogLevel = 'info' | 'warn' | 'error';
export type LogSource = 'server' | 'client' | 'audit';

export type LogContext = Record<string, unknown>;

const REDACT_KEYS = [
  /password/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /secret/i,
  /api[_-]?key/i,
  /supabase/i,
];

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 4;
const MAX_STACK_LENGTH = 2000;

function truncateString(value: string, maxLength = MAX_STRING_LENGTH) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[MaxDepth]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Error) {
    return normalizeError(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeValue(entry, depth + 1));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (REDACT_KEYS.some((pattern) => pattern.test(key))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeValue(entry, depth + 1);
      }
    }
    return result;
  }

  return truncateString(String(value));
}

export function sanitizeContext(input?: unknown): LogContext | undefined {
  if (input === undefined || input === null) return undefined;
  if (isPlainObject(input)) {
    return sanitizeValue(input, 0) as LogContext;
  }
  return { value: sanitizeValue(input, 0) };
}

export function truncateMessage(message: string) {
  return truncateString(message, MAX_STRING_LENGTH);
}

export function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncateString(error.message, MAX_STRING_LENGTH),
      stack: error.stack ? truncateString(error.stack, MAX_STACK_LENGTH) : undefined,
    };
  }
  if (typeof error === 'string') {
    return { message: truncateString(error, MAX_STRING_LENGTH) };
  }
  if (isPlainObject(error) && 'message' in error && typeof error.message === 'string') {
    return { message: truncateString(error.message, MAX_STRING_LENGTH) };
  }
  return { message: 'Unknown error' };
}
