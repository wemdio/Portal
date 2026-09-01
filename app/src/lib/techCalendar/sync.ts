import type { SupabaseClient } from '@supabase/supabase-js';

import { runProxyMarketTechCalendarSync, type ProxyMarketSyncResult } from '@/lib/techCalendar/proxyMarketSync';
import { runSerperBalanceSync, type SerperBalanceSyncResult } from '@/lib/techCalendar/serperBalanceSync';
import { runSpaceProxyTechCalendarSync, type TechCalendarSyncResult } from '@/lib/techCalendar/spaceProxySync';

export interface RunTechCalendarSyncDeps {
  db: SupabaseClient;
  now: Date;
  spaceProxyApiKey?: string;
  serperApiKey?: string;
  proxyMarketApiKey?: string;
}

export interface ProviderSyncOutcome<T> {
  ok: boolean;
  result?: T;
  error?: string;
  skipped?: boolean;
}

export interface RunTechCalendarSyncResult {
  spaceproxy: ProviderSyncOutcome<TechCalendarSyncResult>;
  serper: ProviderSyncOutcome<SerperBalanceSyncResult>;
  proxymarket: ProviderSyncOutcome<ProxyMarketSyncResult>;
}

function skipped<T>(message: string): ProviderSyncOutcome<T> {
  return { ok: false, skipped: true, error: message };
}

function failed<T>(e: unknown): ProviderSyncOutcome<T> {
  return { ok: false, error: e instanceof Error ? e.message : 'Sync failed' };
}

export async function runTechCalendarSync(deps: RunTechCalendarSyncDeps): Promise<RunTechCalendarSyncResult> {
  const result: RunTechCalendarSyncResult = {
    spaceproxy: skipped('SPACEPROXY_API_KEY is not set'),
    serper: skipped('SERPER_API_KEY is not set'),
    proxymarket: skipped('PROXY_MARKET_API_KEY is not set'),
  };

  const spaceProxyApiKey = deps.spaceProxyApiKey?.trim();
  if (spaceProxyApiKey) {
    try {
      result.spaceproxy = {
        ok: true,
        result: await runSpaceProxyTechCalendarSync({
          db: deps.db,
          apiKey: spaceProxyApiKey,
          now: deps.now,
        }),
      };
    } catch (e) {
      result.spaceproxy = failed(e);
    }
  }

  const serperApiKey = deps.serperApiKey?.trim();
  if (serperApiKey) {
    try {
      result.serper = {
        ok: true,
        result: await runSerperBalanceSync({
          db: deps.db,
          apiKey: serperApiKey,
          now: deps.now,
        }),
      };
    } catch (e) {
      result.serper = failed(e);
    }
  }

  const proxyMarketApiKey = deps.proxyMarketApiKey?.trim();
  if (proxyMarketApiKey) {
    try {
      result.proxymarket = {
        ok: true,
        result: await runProxyMarketTechCalendarSync({
          db: deps.db,
          apiKey: proxyMarketApiKey,
          now: deps.now,
        }),
      };
    } catch (e) {
      result.proxymarket = failed(e);
    }
  }

  return result;
}
