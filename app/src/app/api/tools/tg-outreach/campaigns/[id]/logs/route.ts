import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

  const { data, error, count } = await auth.supabase
    .from('tg_outreach_logs')
    .select('*', { count: 'exact' })
    .eq('campaign_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ items: data ?? [], total: count ?? 0 });
}
