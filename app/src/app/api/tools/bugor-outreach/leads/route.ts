import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { searchParams } = req.nextUrl;
  const batchDate = searchParams.get('batch_date');
  const priority = searchParams.get('priority');
  const signalType = searchParams.get('signal_type');
  const limit = Math.min(Number(searchParams.get('limit') ?? '200'), 500);

  let query = supabaseAdmin
    .from('bugor_outreach_leads')
    .select('*')
    .order('intent_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (batchDate) {
    query = query.eq('batch_date', batchDate);
  }
  if (priority) {
    query = query.eq('priority', priority);
  }
  if (signalType) {
    query = query.eq('signal_type', signalType);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ leads: data ?? [], total: data?.length ?? 0 });
}
