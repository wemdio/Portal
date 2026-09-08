import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface ProviderUsageScope {
  projectId: string;
  baseId?: string;
  jobId: string;
  stage: string;
}

export interface ProviderUsageEvent {
  attemptId: string;
  provider: 'requesty' | 'serper';
  phase: 'started' | 'finished';
  status?: 'success' | 'http_error' | 'ambiguous';
  requestedModel?: string;
  actualModel?: string;
  providerRequestId?: string;
  httpStatus?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
  serperCredits?: number;
}

export type ProviderUsageDetails = Omit<ProviderUsageEvent, 'attemptId' | 'provider' | 'phase'>;
type ProviderUsageWriter = (scope: ProviderUsageScope, event: ProviderUsageEvent) => Promise<void>;

interface ProviderUsageContext {
  scope: ProviderUsageScope;
  writer: ProviderUsageWriter;
  failure?: ProviderUsageWriteError;
}

const storage = new AsyncLocalStorage<ProviderUsageContext>();

/** A failed journal write must not be converted to an empty provider result. */
export class ProviderUsageWriteError extends Error {
  constructor() {
    super('Provider usage journal could not be saved.');
    this.name = 'ProviderUsageWriteError';
  }
}

export function getProviderUsageScope(): ProviderUsageScope | undefined {
  const context = storage.getStore();
  return context ? { ...context.scope } : undefined;
}

export async function withProviderUsage<T>(
  scope: ProviderUsageScope,
  writer: ProviderUsageWriter,
  work: () => Promise<T>,
): Promise<T> {
  const context: ProviderUsageContext = { scope: { ...scope }, writer };
  return storage.run(context, async () => {
    try {
      const result = await work();
      if (context.failure) throw context.failure;
      return result;
    } catch (error) {
      throw context.failure ?? error;
    }
  });
}

// Explicitly select telemetry fields: callers cannot accidentally journal query
// text, request bodies, credentials, or override an attempt's identity.
function usageDetails(details: ProviderUsageDetails): ProviderUsageDetails {
  const result: ProviderUsageDetails = {};
  if (['success', 'http_error', 'ambiguous'].includes(details.status ?? '')) result.status = details.status;
  for (const field of ['requestedModel', 'actualModel', 'providerRequestId'] as const) {
    const value = details[field];
    if (typeof value === 'string' && value.trim()) result[field] = value.trim().slice(0, 256);
  }
  for (const field of [
    'httpStatus', 'promptTokens', 'completionTokens', 'cachedTokens',
    'reportedCostUsd', 'estimatedCostUsd', 'serperCredits',
  ] as const) {
    const value = details[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[field] = value;
  }
  return result;
}

export async function beginProviderUsage(
  provider: ProviderUsageEvent['provider'],
  extras: ProviderUsageDetails = {},
): Promise<{ finish: (event: ProviderUsageDetails) => Promise<void> }> {
  const context = storage.getStore();
  if (!context) return { finish: async () => undefined };
  if (context.failure) throw context.failure;
  const attemptId = randomUUID();
  const initial = usageDetails(extras);
  const write = async (event: ProviderUsageEvent): Promise<void> => {
    try {
      await context.writer({ ...context.scope }, event);
    } catch {
      context.failure ??= new ProviderUsageWriteError();
      throw context.failure;
    }
  };
  await write({ ...initial, attemptId, provider, phase: 'started' });
  if (context.failure) throw context.failure;
  let finished: Promise<void> | undefined;
  return {
    finish(event) {
      // A rejected finish remains rejected. Retrying a different finish must not
      // overwrite a failed write with an apparently complete accounting record.
      finished ??= write({ ...initial, ...usageDetails(event), attemptId, provider, phase: 'finished' });
      return finished;
    },
  };
}
