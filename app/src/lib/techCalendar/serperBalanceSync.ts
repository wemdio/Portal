import type { SupabaseClient } from '@supabase/supabase-js';

const SERPER_ACCOUNT_URL = 'https://google.serper.dev/account';

interface SerperAccountResponse {
  balance?: number | string | null;
}

export interface SerperBalanceSyncDeps {
  db: SupabaseClient;
  apiKey: string;
  now: Date;
  fetchImpl?: typeof fetch;
}

export interface SerperBalanceSyncResult {
  balance: number;
}

function parseBalance(value: unknown): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new Error('Serper API did not return credits balance');
  }
  return Math.round(num * 100) / 100;
}

async function writeSerperError(db: SupabaseClient, message: string): Promise<void> {
  const res = await db.from('tech_provider_balances').upsert(
    {
      provider: 'serper',
      label: 'Serper',
      unit: 'credits',
      last_error: message,
    },
    { onConflict: 'provider' },
  );
  if (res.error) throw new Error(`tech_provider_balances error write failed: ${res.error.message}`);
}

export async function runSerperBalanceSync(deps: SerperBalanceSyncDeps): Promise<SerperBalanceSyncResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(SERPER_ACCOUNT_URL, {
      headers: {
        Accept: 'application/json',
        'X-API-KEY': deps.apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Serper API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as SerperAccountResponse;
    const balance = parseBalance(json.balance);
    const upsert = await deps.db.from('tech_provider_balances').upsert(
      {
        provider: 'serper',
        label: 'Serper',
        balance,
        unit: 'credits',
        synced_at: deps.now.toISOString(),
        last_error: null,
      },
      { onConflict: 'provider' },
    );

    if (upsert.error) throw new Error(`tech_provider_balances upsert failed: ${upsert.error.message}`);
    return { balance };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Serper sync failed';
    await writeSerperError(deps.db, message);
    throw e;
  }
}
