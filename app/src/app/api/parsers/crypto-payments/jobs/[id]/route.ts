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
 * GET /api/parsers/crypto-payments/jobs/[id] — get job status & results
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const client = createAuthedSupabaseClient(token);
  const { data: { user } } = await client.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { id } = await params;

  const { data: job, error } = await supabaseAdmin
    .from('crypto_payment_jobs')
    .select('id, file_name, status, checked_count, total_count, matches, error_message, created_at, updated_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error || !job) return jsonError('Job not found', 404);

  return NextResponse.json(job);
}

/**
 * DELETE /api/parsers/crypto-payments/jobs/[id] — delete a job
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const client = createAuthedSupabaseClient(token);
  const { data: { user } } = await client.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { id } = await params;

  const { error } = await supabaseAdmin
    .from('crypto_payment_jobs')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true });
}
