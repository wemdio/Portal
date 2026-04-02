import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin as _supabaseAdmin } from '@/lib/supabaseAdmin';

const supabaseAdmin = _supabaseAdmin!;

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/parsers/crypto-payments/jobs/[id]/resume — resume a stopped/errored job
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const client = createAuthedSupabaseClient(token);
  const { data: { user } } = await client.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { id } = await params;

  const { data: job } = await supabaseAdmin
    .from('crypto_payment_jobs')
    .select('id, status, checked_count, total_count')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!job) return jsonError('Job not found', 404);
  if (job.status !== 'stopped' && job.status !== 'error') {
    return jsonError('Job cannot be resumed (current status: ' + job.status + ')', 400);
  }
  if (job.checked_count >= job.total_count) {
    return jsonError('Job is already fully checked', 400);
  }

  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from('crypto_payment_jobs')
    .update({ status: 'stopped', updated_at: nowIso })
    .eq('user_id', user.id)
    .neq('id', id)
    .in('status', ['pending', 'running']);

  // Set back to pending — enrich worker will pick it up and resume from checked_count
  await supabaseAdmin
    .from('crypto_payment_jobs')
    .update({ status: 'pending', error_message: null, updated_at: nowIso })
    .eq('id', id);

  return NextResponse.json({ ok: true, resumeFrom: job.checked_count });
}
