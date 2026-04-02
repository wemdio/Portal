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
 * POST /api/parsers/crypto-payments/jobs — create a new scan job
 * Body: { fileName: string, items: Array<{companyName, website}> }
 */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const client = createAuthedSupabaseClient(token);
  const { data: { user } } = await client.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: { fileName?: string; items?: unknown };
  try {
    body = (await req.json()) as { fileName?: string; items?: unknown };
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map((item) => {
      const obj = (item ?? {}) as Record<string, unknown>;
      return {
        companyName: String(obj.companyName ?? '').trim(),
        website: String(obj.website ?? '').trim(),
      };
    })
    .filter((item) => item.website);

  if (items.length === 0) return jsonError('No items to scan', 400);

  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from('crypto_payment_jobs')
    .update({ status: 'stopped', updated_at: nowIso })
    .eq('user_id', user.id)
    .in('status', ['pending', 'running']);

  const { data: job, error } = await supabaseAdmin
    .from('crypto_payment_jobs')
    .insert({
      user_id: user.id,
      file_name: body.fileName ?? 'unknown.xlsx',
      items,
      total_count: items.length,
      status: 'pending',
    })
    .select('id, status, checked_count, total_count, created_at')
    .single();

  if (error) return jsonError(error.message, 500);

  return NextResponse.json(job, { status: 201 });
}

/**
 * GET /api/parsers/crypto-payments/jobs — list user's jobs
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const client = createAuthedSupabaseClient(token);
  const { data: { user } } = await client.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: jobs, error } = await supabaseAdmin
    .from('crypto_payment_jobs')
    .select('id, file_name, status, checked_count, total_count, matches, error_message, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return jsonError(error.message, 500);

  return NextResponse.json(jobs ?? []);
}
