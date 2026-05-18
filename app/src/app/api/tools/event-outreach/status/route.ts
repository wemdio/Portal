import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Returns a collect job's status. With ?jobId= returns that job; without it
 * returns the most recent job (so the UI can resume polling after a reload).
 */
export async function GET(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const jobId = req.nextUrl.searchParams.get('jobId');

  let query = supabaseAdmin
    .from('event_outreach_jobs')
    .select('id, status, params, stats, error_message, created_at, completed_at');

  query = jobId
    ? query.eq('id', jobId)
    : query.order('created_at', { ascending: false }).limit(1);

  const { data, error } = await query.maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ job: data ?? null });
}
