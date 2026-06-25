import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getJobIdFromUrl(req: NextRequest) {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean);
  return parts[parts.length - 2] ?? '';
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  const jobId = getJobIdFromUrl(req);
  const { data: job, error } = await supabase
    .from('yandex_maps_jobs')
    .select('id, status')
    .eq('id', jobId)
    .single();

  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError('Not found', 404);
  if (job.status === 'running') return jsonError('Job is already running', 409);

  // Reset to 'pending' so the worker picks it up for the collect-links step.
  // Failed/cancelled jobs can be re-triggered this way too.
  await supabase
    .from('yandex_maps_jobs')
    .update({ status: 'pending', progress_stage: 'pending', error_message: null })
    .eq('id', jobId);

  return NextResponse.json({ ok: true }, { status: 202 });
}
