import type { SupabaseClient } from '@supabase/supabase-js';

import { mskDateStr } from '@/lib/techCalendar/dates';
import type { Currency, TechStatus } from '@/lib/techCalendar/types';

const PROXY_MARKET_API_BASE = 'https://api.dashboard.proxy.market/dev-api';
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

export interface ProxyMarketApiProxy {
  id?: number | string;
  ip?: string | null;
  host?: string | null;
  expired_at?: string | number | null;
  bought_at?: string | number | null;
  proxy_type?: string | null;
  type?: string | null;
  country?: string | null;
  status?: string | null;
  tags?: unknown;
}

interface ProxyMarketListResponse {
  success?: boolean;
  balance?: number | string | null;
  list?: {
    total?: number;
    data?: ProxyMarketApiProxy[];
  };
}

interface ProxyMarketBalanceResponse {
  balance?: number | string | null;
}

interface ExistingProxyMarketRow {
  external_key: string;
  amount: number | null;
  currency: Currency | null;
  notes: string | null;
  is_hidden: boolean | null;
}

export interface ProxyMarketSyncDeps {
  db: SupabaseClient;
  apiKey: string;
  now: Date;
  fetchImpl?: typeof fetch;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface ProxyMarketSyncResult {
  seen: number;
  upserted: number;
  skipped: number;
  balance: number | null;
  balanceError?: string;
}

function validDate(y: number, m: number, d: number): string | null {
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const ru = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(trimmed);
  if (ru) return validDate(Number(ru[3]), Number(ru[2]), Number(ru[1]));

  if (/^\d+$/.test(trimmed)) return normalizeDate(Number(trimmed));
  return null;
}

function normalizePart(value: unknown, fallback = 'unknown'): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function parseBalance(value: unknown): number {
  const normalized = typeof value === 'string' ? value.replace(',', '.').trim() : value;
  const num = typeof normalized === 'string' ? Number(normalized) : normalized;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new Error('proxy.market API did not return balance');
  }
  return Math.round(num * 100) / 100;
}

function buildServiceName(proxy: ProxyMarketApiProxy): string {
  const ip = normalizePart(proxy.ip ?? proxy.host, `ID ${normalizePart(proxy.id)}`);
  const type = normalizePart(proxy.proxy_type ?? proxy.type, 'proxy');
  const country = normalizePart(proxy.country, '').toUpperCase();
  return country ? `proxy.market · ${type} ${country} · ${ip}` : `proxy.market · ${type} · ${ip}`;
}

function providerStatus(proxy: ProxyMarketApiProxy, billingDate: string, today: string): string {
  const fromApi = normalizePart(proxy.status, '');
  if (fromApi) return fromApi;
  return billingDate < today ? 'expired' : 'active';
}

function calendarStatus(proxyStatus: string, billingDate: string, today: string): TechStatus {
  const normalized = proxyStatus.toLowerCase();
  if (normalized === 'deleted' || normalized === 'archived' || billingDate < today) return 'cancel';
  return 'active';
}

async function fetchProxyMarketPage(
  apiKey: string,
  page: number,
  fetchImpl: typeof fetch,
): Promise<ProxyMarketListResponse> {
  const res = await fetchImpl(`${PROXY_MARKET_API_BASE}/list/${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'all',
      page,
      page_size: PAGE_SIZE,
      sort: 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`proxy.market list API error ${res.status}: ${body.slice(0, 200)}`);
  }

  return (await res.json()) as ProxyMarketListResponse;
}

async function fetchProxyMarketProxies(apiKey: string, fetchImpl: typeof fetch): Promise<ProxyMarketApiProxy[]> {
  const proxies: ProxyMarketApiProxy[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await fetchProxyMarketPage(apiKey, page, fetchImpl);
    if (json.success === false) throw new Error('proxy.market list API returned success=false');

    const batch = Array.isArray(json.list?.data) ? json.list.data : [];
    proxies.push(...batch);

    const total = typeof json.list?.total === 'number' ? json.list.total : null;
    if (!batch.length || (total !== null && proxies.length >= total)) break;
  }

  return proxies;
}

async function fetchProxyMarketBalance(apiKey: string, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(`${PROXY_MARKET_API_BASE}/balance/${encodeURIComponent(apiKey)}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`proxy.market balance API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as ProxyMarketBalanceResponse;
  return parseBalance(json.balance);
}

async function writeProxyMarketBalance(db: SupabaseClient, now: Date, balance: number): Promise<void> {
  const res = await db.from('tech_provider_balances').upsert(
    {
      provider: 'proxymarket',
      label: 'proxy.market',
      balance,
      unit: 'RUB',
      synced_at: now.toISOString(),
      last_error: null,
    },
    { onConflict: 'provider' },
  );
  if (res.error) throw new Error(`tech_provider_balances upsert failed: ${res.error.message}`);
}

async function writeProxyMarketError(db: SupabaseClient, message: string): Promise<void> {
  const res = await db.from('tech_provider_balances').upsert(
    {
      provider: 'proxymarket',
      label: 'proxy.market',
      unit: 'RUB',
      last_error: message,
    },
    { onConflict: 'provider' },
  );
  if (res.error) throw new Error(`tech_provider_balances error write failed: ${res.error.message}`);
}

export async function runProxyMarketTechCalendarSync(deps: ProxyMarketSyncDeps): Promise<ProxyMarketSyncResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((level, msg, extra) => {
    if (extra !== undefined) console[level](`[tech-calendar-proxymarket] ${msg}`, extra);
    else console[level](`[tech-calendar-proxymarket] ${msg}`);
  });
  const today = mskDateStr(deps.now);

  try {
    const proxies = await fetchProxyMarketProxies(deps.apiKey, fetchImpl);

    const existingRes = await deps.db
      .from('tech_subscriptions')
      .select('external_key, amount, currency, notes, is_hidden')
      .eq('source', 'proxymarket');

    if (existingRes.error) {
      throw new Error(`tech_subscriptions load failed: ${existingRes.error.message}`);
    }

    const existing = new Map(
      ((existingRes.data ?? []) as ExistingProxyMarketRow[]).map((row) => [row.external_key, row]),
    );

    let skipped = 0;
    const rows = proxies.flatMap((proxy) => {
      const id = normalizePart(proxy.id, '');
      const billingDate = normalizeDate(proxy.expired_at);
      if (!id || !billingDate) {
        skipped++;
        return [];
      }

      const status = providerStatus(proxy, billingDate, today);
      const normalizedStatus = status.toLowerCase();
      if (normalizedStatus === 'deleted' || normalizedStatus === 'archived') {
        skipped++;
        return [];
      }

      const externalKey = `proxymarket:${id}`;
      const old = existing.get(externalKey);

      return [{
        source: 'proxymarket',
        external_key: externalKey,
        service_name: buildServiceName(proxy),
        service_type: 'proxy',
        amount: old?.amount ?? 0,
        currency: old?.currency ?? 'RUB',
        billing_cycle: 'monthly',
        next_billing_date: billingDate,
        status: calendarStatus(status, billingDate, today),
        decision_by: null,
        decision_at: null,
        decision_notes: null,
        notes: old?.notes ?? null,
        quantity: 1,
        provider_status: normalizedStatus || status,
        synced_at: deps.now.toISOString(),
        is_hidden: old?.is_hidden ?? false,
      }];
    });

    if (rows.length) {
      const upsertRes = await deps.db
        .from('tech_subscriptions')
        .upsert(rows, { onConflict: 'source,external_key' });

      if (upsertRes.error) {
        throw new Error(`tech_subscriptions upsert failed: ${upsertRes.error.message}`);
      }
    } else {
      log('warn', 'proxy.market returned no usable proxy rows', { seen: proxies.length, skipped });
    }

    try {
      const balance = await fetchProxyMarketBalance(deps.apiKey, fetchImpl);
      await writeProxyMarketBalance(deps.db, deps.now, balance);
      return { seen: proxies.length, upserted: rows.length, skipped, balance };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'proxy.market balance sync failed';
      await writeProxyMarketError(deps.db, message);
      return { seen: proxies.length, upserted: rows.length, skipped, balance: null, balanceError: message };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'proxy.market sync failed';
    await writeProxyMarketError(deps.db, message);
    throw e;
  }
}
