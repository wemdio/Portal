import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIER_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 };

export async function GET(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { searchParams } = req.nextUrl;
  const batchDate = searchParams.get('batch_date');
  const tier = searchParams.get('tier');
  const limit = Math.min(Number(searchParams.get('limit') ?? '500'), 2000);

  let query = supabaseAdmin
    .from('event_outreach_leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (batchDate) query = query.eq('batch_date', batchDate);
  if (tier) query = query.eq('tier', tier);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sort hot -> warm -> cold within the page for display.
  const leads = (data ?? []).sort(
    (a, b) => (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3),
  );

  return NextResponse.json({ leads, total: leads.length });
}
