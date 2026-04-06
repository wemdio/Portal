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

export interface RegruDomain {
  dname: string;
  service_id: string;
  state: 'A' | 'N' | 'S' | 'D' | 'O';
  creation_date: string;
  expiration_date: string;
  subtype: string;
}

async function fetchRegruDomains(): Promise<RegruDomain[]> {
  const username = process.env.REGRU_USERNAME;
  const password = process.env.REGRU_PASSWORD;
  if (!username || !password) {
    throw new Error('REGRU_USERNAME / REGRU_PASSWORD not configured');
  }

  const params = new URLSearchParams({
    username,
    password,
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
    throw new Error(`Reg.ru API responded with ${res.status}`);
  }

  const data = await res.json() as {
    result: string;
    error_code?: string;
    error_text?: string;
    answer?: { services?: RegruDomain[] };
  };

  if (data.result !== 'success') {
    throw new Error(data.error_text ?? data.error_code ?? 'Reg.ru API error');
  }

  return data.answer?.services ?? [];
}

/**
 * GET /api/admin/domains
 * Fetch all domains from Reg.ru with expiration info. Admin only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  try {
    const domains = await fetchRegruDomains();

    const sorted = domains
      .filter((d) => d.state !== 'D')
      .sort((a, b) => new Date(a.expiration_date).getTime() - new Date(b.expiration_date).getTime());

    return NextResponse.json({ domains: sorted });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonError(message, 502);
  }
}
