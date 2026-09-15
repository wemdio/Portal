import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Hourly Instantly API usage counters (instantly_api_usage_hourly).
 *
 * Fire-and-forget by design: counting must never delay or fail a provider
 * call — the worst case of a lost counter is a blind spot in reporting, not a
 * broken request path. One upsert per attempt/deferral; the RPC aggregates
 * atomically and opportunistically purges rows older than 35 days.
 */

export type InstantlyUsageStatus =
  | 'ok'
  | 'http_429'
  | 'http_error'
  | 'network_error'
  | 'deferred_budget'
  | 'deferred_recovery_budget'
  | 'deferred_bulk_budget'
  | 'deferred_cooldown'
  | 'deferred_storage_unavailable';

export interface InstantlyUsageRecord {
  accountId: string;
  /** Request path with ids stripped, e.g. '/emails', '/campaigns/{id}'. */
  endpoint: string;
  /** Logical consumer: discovery, qualification, client_feed, export, … */
  consumer: string;
  status: InstantlyUsageStatus;
}

const MAX_LEN = 128;

function clip(value: string): string {
  return value.length > MAX_LEN ? value.slice(0, MAX_LEN) : value;
}

/** Path (or full URL) → endpoint label: query dropped, ids/emails collapsed. */
export function instantlyUsageEndpoint(pathOrUrl: string): string {
  const path = pathOrUrl.replace(/^https?:\/\/[^/]+\/api\/v2/i, '').split('?')[0];
  return path.replace(/\/[0-9a-f-]{16,}/gi, '/{id}').replace(/\/[^/?#]{8,}@[^\s/?#]+/gi, '/{email}');
}

/** Status label for one finished HTTP attempt. */
export function instantlyUsageStatusFromHttp(status: number): InstantlyUsageStatus {
  if (status === 429) return 'http_429';
  return status >= 200 && status < 400 ? 'ok' : 'http_error';
}

export function recordInstantlyApiUsage(record: InstantlyUsageRecord): void {
  if (!supabaseAdmin) return;
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  try {
    // Promise.resolve: builder-моки в тестах (и любые не-thenable) не должны
    // ронять вызывающий путь; синхронный throw глотаем тем же try/catch.
    void Promise.resolve(
      supabaseAdmin.rpc('instantly_bump_api_usage', {
        p_hour: hour.toISOString(),
        p_account: clip(record.accountId),
        p_endpoint: clip(record.endpoint),
        p_consumer: clip(record.consumer),
        p_status: record.status,
        p_count: 1,
      }),
    ).then(() => undefined, () => undefined);
  } catch {
    /* counting must never break the request path */
  }
}
