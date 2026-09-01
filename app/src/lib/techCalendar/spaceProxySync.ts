import type { SupabaseClient } from '@supabase/supabase-js';

import { mskDateStr } from '@/lib/techCalendar/dates';
import {
  isDueKeptProviderCycle,
  mergeProviderSubscriptionDecision,
  type ExistingProviderSubscriptionDecision,
} from '@/lib/techCalendar/providerSyncDecision';
import type { Currency, TechStatus } from '@/lib/techCalendar/types';

const SPACEPROXY_API_BASE = 'https://panel.spaceproxy.net/api';

export interface SpaceProxyApiProxy {
  id?: number | string;
  ip?: string | null;
  order_id?: number | string | null;
  type?: string | null;
  ip_version?: number | string | null;
  country?: string | null;
  date?: string | null;
  date_end?: string | null;
  status?: string | null;
  tags?: unknown;
}

interface SpaceProxyListResponse {
  count?: number;
  results?: SpaceProxyApiProxy[];
}

interface ExistingSpaceProxyRow extends ExistingProviderSubscriptionDecision {
  external_key: string;
  amount: number | null;
  currency: Currency | null;
  notes: string | null;
  is_hidden: boolean | null;
}

export interface TechCalendarSyncDeps {
  db: SupabaseClient;
  apiKey: string;
  now: Date;
  fetchImpl?: typeof fetch;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface TechCalendarSyncResult {
  seen: number;
  upserted: number;
  skipped: number;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (!match) return null;
  const [y, m, d] = match[1].split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return match[1];
}

function normalizePart(value: unknown, fallback = 'unknown'): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function buildServiceName(proxy: SpaceProxyApiProxy): string {
  const ip = normalizePart(proxy.ip, `ID ${normalizePart(proxy.id)}`);
  const version = normalizePart(proxy.ip_version);
  const country = normalizePart(proxy.country).toUpperCase();
  const type = normalizePart(proxy.type);
  return `SpaceProxy · IPv${version} ${country} · ${type} · ${ip}`;
}

function providerStatus(proxy: SpaceProxyApiProxy, billingDate: string, today: string): string {
  const fromApi = normalizePart(proxy.status, '');
  if (fromApi) return fromApi;
  return billingDate < today ? 'expired' : 'active';
}

function calendarStatus(proxyStatus: string, billingDate: string, today: string): TechStatus {
  if (proxyStatus === 'deleted' || billingDate < today) return 'cancel';
  return 'active';
}

async function fetchSpaceProxyProxies(apiKey: string, fetchImpl: typeof fetch): Promise<SpaceProxyApiProxy[]> {
  const url = new URL(`${SPACEPROXY_API_BASE}/proxies/`);
  url.searchParams.set('limit', '2000');

  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'API-KEY': apiKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SpaceProxy API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as SpaceProxyListResponse;
  return Array.isArray(json.results) ? json.results : [];
}

export async function runSpaceProxyTechCalendarSync(deps: TechCalendarSyncDeps): Promise<TechCalendarSyncResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((level, msg, extra) => {
    if (extra !== undefined) console[level](`[tech-calendar-spaceproxy] ${msg}`, extra);
    else console[level](`[tech-calendar-spaceproxy] ${msg}`);
  });
  const today = mskDateStr(deps.now);

  const proxies = await fetchSpaceProxyProxies(deps.apiKey, fetchImpl);

  const existingRes = await deps.db
    .from('tech_subscriptions')
    .select('external_key, amount, currency, notes, is_hidden, status, next_billing_date, decision_by, decision_at, decision_notes')
    .eq('source', 'spaceproxy');

  if (existingRes.error) {
    throw new Error(`tech_subscriptions load failed: ${existingRes.error.message}`);
  }

  const existing = new Map(
    ((existingRes.data ?? []) as ExistingSpaceProxyRow[]).map((row) => [row.external_key, row]),
  );

  let skipped = 0;
  const rows = proxies.flatMap((proxy) => {
    const id = normalizePart(proxy.id, '');
    const billingDate = normalizeDate(proxy.date_end);
    if (!id || !billingDate) {
      skipped++;
      return [];
    }

    const status = providerStatus(proxy, billingDate, today);
    if (status === 'deleted') {
      skipped++;
      return [];
    }

    const externalKey = `spaceproxy:${id}`;
    const old = existing.get(externalKey);
    if (isDueKeptProviderCycle(old, today)) {
      skipped++;
      return [];
    }
    const decision = mergeProviderSubscriptionDecision(old, {
      status: calendarStatus(status, billingDate, today),
      next_billing_date: billingDate,
    });

    return [{
      source: 'spaceproxy',
      external_key: externalKey,
      service_name: buildServiceName(proxy),
      service_type: 'proxy',
      amount: old?.amount ?? 0,
      currency: old?.currency ?? 'USD',
      billing_cycle: 'monthly',
      next_billing_date: decision.next_billing_date,
      status: decision.status,
      decision_by: decision.decision_by,
      decision_at: decision.decision_at,
      decision_notes: decision.decision_notes,
      notes: old?.notes ?? null,
      quantity: 1,
      provider_status: status,
      synced_at: deps.now.toISOString(),
      is_hidden: old?.is_hidden ?? false,
    }];
  });

  if (!rows.length) {
    log('warn', 'SpaceProxy returned no usable proxy rows', { seen: proxies.length, skipped });
    return { seen: proxies.length, upserted: 0, skipped };
  }

  const upsertRes = await deps.db
    .from('tech_subscriptions')
    .upsert(rows, { onConflict: 'source,external_key' });

  if (upsertRes.error) {
    throw new Error(`tech_subscriptions upsert failed: ${upsertRes.error.message}`);
  }

  return { seen: proxies.length, upserted: rows.length, skipped };
}
