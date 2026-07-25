import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { callRegruApi, getRegruAccounts } from '@/lib/regru/client';
import type { RegruAccount } from '@/lib/regru/client';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdmin(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') return { error: jsonError('Forbidden', 403) };
  return { user, profile };
}

export interface RegruDomain {
  dname: string;
  service_id: string;
  state: 'A' | 'N' | 'S' | 'D' | 'O';
  creation_date: string;
  expiration_date: string;
  subtype: string;
  account: string;
}

async function fetchDomainsForAccount(account: RegruAccount): Promise<RegruDomain[]> {
  const answer = await callRegruApi<{ services?: Omit<RegruDomain, 'account'>[] }>(
    'service/get_list',
    { servtype: 'domain' },
    account,
  );
  return (answer?.services ?? []).map((d) => ({ ...d, account: account.name }));
}

/**
 * GET /api/admin/domains
 * Fetch all domains from all configured Reg.ru accounts. Admin only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const accounts = getRegruAccounts();
  if (accounts.length === 0) {
    return jsonError('No Reg.ru accounts configured. Set REGRU_ACCOUNTS or REGRU_USERNAME/REGRU_PASSWORD.', 500);
  }

  const results = await Promise.allSettled(accounts.map(fetchDomainsForAccount));

  const domains: RegruDomain[] = [];
  const errors: string[] = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      domains.push(...r.value);
    } else {
      errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }

  const sorted = domains
    .filter((d) => d.state !== 'D')
    .sort((a, b) => new Date(a.expiration_date).getTime() - new Date(b.expiration_date).getTime());

  return NextResponse.json({
    domains: sorted,
    accounts: accounts.map((a) => a.name),
    ...(errors.length > 0 ? { errors } : {}),
  });
}
