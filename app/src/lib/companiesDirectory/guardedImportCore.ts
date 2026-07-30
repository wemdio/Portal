import { createHash } from 'node:crypto';

export type JsonObject = Record<string, unknown>;

const CURRENT_PRODUCTION_HOST = '139.60.162.12';
const FORMER_PRODUCTION_HOST = '144.31.54.166';
const CURRENT_PRODUCTION_PORT = 35434;
const CURRENT_PRODUCTION_DATABASE = 'postgres';

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertSha256Hex(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

export function assertPortalProductionTarget(
  connectionString: string,
  confirmedTarget: string | undefined,
  importLabel: string,
): {
  host: string;
  port: number;
  database: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${importLabel} database URL is invalid`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${importLabel} database URL must use postgres`);
  }
  if (parsed.hostname === FORMER_PRODUCTION_HOST) {
    throw new Error(
      `Refusing the former production host ${FORMER_PRODUCTION_HOST}`,
    );
  }
  if (confirmedTarget !== CURRENT_PRODUCTION_HOST) {
    throw new Error(
      `Production target must be explicitly confirmed as ${CURRENT_PRODUCTION_HOST}`,
    );
  }
  if (parsed.hostname !== CURRENT_PRODUCTION_HOST) {
    throw new Error(
      `${importLabel} database host must be ${CURRENT_PRODUCTION_HOST}`,
    );
  }
  const port = Number(parsed.port);
  if (port !== CURRENT_PRODUCTION_PORT) {
    throw new Error(
      `${importLabel} database port must be ${CURRENT_PRODUCTION_PORT}`,
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (database !== CURRENT_PRODUCTION_DATABASE) {
    throw new Error(
      `${importLabel} database must be ${CURRENT_PRODUCTION_DATABASE}`,
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (key !== 'sslmode') {
      throw new Error(
        `${importLabel} database URL query parameter "${key}" is forbidden`,
      );
    }
  }
  return {
    host: parsed.hostname,
    port,
    database,
  };
}
