import 'server-only';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { withVeDeadline } from './operationDeadline';

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
  try {
    return await withVeDeadline('Serper relevance search', 5_000, signal, async (requestSignal) => {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST', signal: requestSignal, redirect: 'error',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 6, gl: 'ru', hl: 'ru' }),
      });
      requestSignal.throwIfAborted();
      if (!response.ok) {
        // Only HTTP 400 needs its body to distinguish exhausted credits from
        // an invalid request. Nothing from that body is retained or displayed.
        const body = response.status === 400 ? await response.text() : '';
        if (response.status !== 400) await response.body?.cancel().catch(() => undefined);
        requestSignal.throwIfAborted();
        throw responseFailure(response.status, body);
      }
      const data: unknown = await response.json();
      requestSignal.throwIfAborted();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new VeSearchProviderError('transient');
      const record = data as Record<string, unknown>;
      if (record.error || (typeof record.statusCode === 'number' && record.statusCode >= 400)) {
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
  }
}
