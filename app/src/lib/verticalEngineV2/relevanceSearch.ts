import 'server-only';
import { beginProviderUsage, getProviderUsageScope, type ProviderUsageDetails } from '@/lib/providerUsage';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { withVeDeadline } from './operationDeadline';

export const VE_RELEVANCE_SEARCH_TIMEOUT_MS = 10_000;
// The evidence reader also bounds injected search adapters and metering around
// the transport. It must leave time for the same request's usage journal.
export const VE_RELEVANCE_SEARCH_OPERATION_TIMEOUT_MS = 15_000;

export interface VeSearchProviderFailure {
  kind: 'billing' | 'configuration' | 'transient';
  message: string;
}

const FAILURE_MESSAGES: Record<VeSearchProviderFailure['kind'], string> = {
  billing: 'Serper billing: insufficient search credits.',
  configuration: 'Serper configuration: search API key or request is invalid.',
  transient: 'Serper transient: search service unavailable.',
};

/** Only stable messages cross the provider boundary; response bodies and keys never do. */
export class VeSearchProviderError extends Error {
  constructor(public readonly kind: VeSearchProviderFailure['kind']) {
    super(FAILURE_MESSAGES[kind]);
    this.name = 'VeSearchProviderError';
  }
}

export function veSearchProviderFailure(error: unknown): VeSearchProviderFailure {
  const kind = error instanceof VeSearchProviderError ? error.kind : 'transient';
  return { kind, message: FAILURE_MESSAGES[kind] };
}

function responseFailure(status: number, body: string): VeSearchProviderError {
  const billing = status === 402 || (status === 400 &&
    /not enough credits|insufficient[\s_-]+(?:funds|balance|credits)|payment[\s_-]+required|credit balance (?:is )?too low/i.test(body));
  return new VeSearchProviderError(billing ? 'billing'
    : status >= 400 && status < 500 && ![408, 425, 429].includes(status) ? 'configuration' : 'transient');
}

/** Strict VE2 search: an empty successful search is data, a provider failure is not. */
export async function searchVeRelevanceWebsites(query: string, signal?: AbortSignal): Promise<SerperOrganicItem[]> {
  signal?.throwIfAborted();
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  if (!apiKey) throw new VeSearchProviderError('configuration');
  const metered = getProviderUsageScope() !== undefined;
  const metering = await beginProviderUsage('serper');
  const usage: ProviderUsageDetails = { status: 'ambiguous' };
  try {
    return await withVeDeadline('Serper relevance search', VE_RELEVANCE_SEARCH_TIMEOUT_MS, signal, async (requestSignal) => {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST', signal: requestSignal, redirect: 'error',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 6, gl: 'ru', hl: 'ru' }),
      });
      usage.httpStatus = response.status;
      usage.providerRequestId = response.headers?.get('x-request-id') ?? undefined;
      if (!response.ok) usage.status = 'http_error';
      requestSignal.throwIfAborted();
      if (!response.ok) {
        // Metered failures may include returned credits. The response body itself
        // is never retained; HTTP 400 also distinguishes exhausted credits.
        const readBody = response.status === 400 || metered;
        const body = readBody ? await response.text() : '';
        if (!readBody) await response.body?.cancel().catch(() => undefined);
        if (metered && body) {
          try { usage.serperCredits = reportedCredits(JSON.parse(body)); } catch { /* Non-JSON error body. */ }
        }
        requestSignal.throwIfAborted();
        throw responseFailure(response.status, body);
      }
      const data: unknown = await response.json();
      usage.serperCredits = reportedCredits(data);
      requestSignal.throwIfAborted();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new VeSearchProviderError('transient');
      const record = data as Record<string, unknown>;
      usage.status = 'success';
      if (record.error || (typeof record.statusCode === 'number' && record.statusCode >= 400)) {
        usage.status = 'http_error';
        throw responseFailure(typeof record.statusCode === 'number' ? record.statusCode : 500,
          typeof record.message === 'string' ? record.message : '');
      }
      if (record.organic !== undefined && !Array.isArray(record.organic)) throw new VeSearchProviderError('transient');
      return ((record.organic ?? []) as unknown[]).filter((item): item is SerperOrganicItem =>
        item != null && typeof item === 'object' && typeof (item as SerperOrganicItem).link === 'string');
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw error instanceof VeSearchProviderError ? error : new VeSearchProviderError('transient');
  } finally {
    await metering.finish(usage);
  }
}

function reportedCredits(data: unknown): number | undefined {
  const credits = data && typeof data === 'object' ? (data as { credits?: unknown }).credits : undefined;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}
