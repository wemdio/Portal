import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const authed = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await authed.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  let body: { inns?: string[] };
  try {
    body = (await req.json()) as { inns?: string[] };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const inns = body.inns ?? [];
  if (!Array.isArray(inns) || inns.length === 0) {
    return jsonError('No INNs provided', 400);
  }
  if (inns.length > 1000) {
    return jsonError('Too many INNs per batch (max 1000)', 400);
  }

  const cleaned = inns.map((inn) => String(inn).trim()).filter(Boolean);

  const { data, error } = await supabaseAdmin
    .from('fns_revenue')
    .select('inn, org_name, income, expense, report_year')
    .in('inn', cleaned);

  if (error) {
    return jsonError(`Database error: ${error.message}`, 500);
  }

  const byInn: Record<string, { org_name: string; income: number; expense: number; report_year: number }> = {};
  for (const row of data ?? []) {
    byInn[row.inn] = {
      org_name: row.org_name,
      income: Number(row.income),
      expense: Number(row.expense),
      report_year: row.report_year,
    };
  }

  return NextResponse.json({ results: byInn, found: Object.keys(byInn).length, total: cleaned.length });
}
