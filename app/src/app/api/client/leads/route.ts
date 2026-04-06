import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const { data, count, error } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('*, client_lead_comments(count)', { count: 'exact' })
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  });
}
