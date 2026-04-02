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
 * POST /api/parsers/crypto-payments/jobs/[id]/stop — stop a running job
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
    .select('id, status')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!job) return jsonError('Job not found', 404);
  if (job.status !== 'running' && job.status !== 'pending') {
    return jsonError('Job is not running', 400);
  }

  await supabaseAdmin
    .from('crypto_payment_jobs')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('id', id);

  return NextResponse.json({ ok: true });
}
