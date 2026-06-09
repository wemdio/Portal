import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function listParam(sp: URLSearchParams, key: string): string[] {
  return Array.from(
    new Set(
      sp.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean),
    ),
  );
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: userData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !userData?.user) return jsonError('Unauthorized', 401);

  const sp = req.nextUrl.searchParams;
  const country = listParam(sp, 'country');
  const industry = listParam(sp, 'industry');
  const size = listParam(sp, 'size');
  const name = (sp.get('name') ?? '').trim();

  const { data, error } = await supabase.rpc('pdl_count_estimate', {
    p_country: country.length ? country : null,
    p_industry: industry.length ? industry : null,
    p_size: size.length ? size : null,
    p_name: name || null,
  });
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ estimate: Number(data ?? 0) });
}
