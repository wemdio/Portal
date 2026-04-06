import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const REGRU_API = 'https://api.reg.ru/api/regru2';

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

interface RegruAccount {
  name: string;
  username: string;
  password: string;
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

function getAccounts(): RegruAccount[] {
  const accounts: RegruAccount[] = [];

  const u1 = process.env.REGRU_USERNAME;
  const p1 = process.env.REGRU_PASSWORD;
  if (u1 && p1) accounts.push({ name: u1, username: u1, password: p1 });

  const u2 = process.env.REGRU_USERNAME_2;
  const p2 = process.env.REGRU_PASSWORD_2;
  if (u2 && p2) accounts.push({ name: u2, username: u2, password: p2 });

  return accounts;
}

async function fetchDomainsForAccount(account: RegruAccount): Promise<RegruDomain[]> {
  const params = new URLSearchParams({
    username: account.username,
    password: account.password,
    input_format: 'json',
    input_data: JSON.stringify({ servtype: 'domain' }),
    output_content_type: 'plain',
  });

  const res = await fetch(`${REGRU_API}/service/get_list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Reg.ru API (${account.name}): HTTP ${res.status}`);
  }

  const data = await res.json() as {
    result: string;
    error_code?: string;
    error_text?: string;
    answer?: { services?: Omit<RegruDomain, 'account'>[] };
  };

  if (data.result !== 'success') {
    throw new Error(`Reg.ru (${account.name}): ${data.error_text ?? data.error_code ?? 'API error'}`);
  }

  return (data.answer?.services ?? []).map((d) => ({ ...d, account: account.name }));
}

/**
 * GET /api/admin/domains
 * Fetch all domains from all configured Reg.ru accounts. Admin only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const accounts = getAccounts();
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
