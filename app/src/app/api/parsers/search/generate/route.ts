
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

import { generateSearchQueries } from '@/lib/parsers/searchQueryGenerator';
function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  try {
    const { brief } = await req.json();
    if (!brief || typeof brief !== 'string') {
      return jsonError('Missing brief text', 400);
    }
    const { queries } = await generateSearchQueries(brief, { allowFallback: false });
    return NextResponse.json({ queries });
  } catch (err) {
    console.error('Generate queries error:', err);
    return jsonError('Failed to generate queries', 500);
  }
}
