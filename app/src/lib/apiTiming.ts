type ApiTimingMeta = Record<string, string | number | boolean | null | undefined>;

function cleanMeta(meta: ApiTimingMeta | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function logApiTiming(
  operation: string,
  durationMs: number,
  meta?: ApiTimingMeta,
): void {
  console.info('[api-timing]', {
    operation,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...cleanMeta(meta),
  });
}

export async function withApiTiming<T>(
  operation: string,
  fn: () => T | Promise<T>,
  meta?: ApiTimingMeta,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    logApiTiming(operation, Date.now() - startedAt, meta);
  }
}
