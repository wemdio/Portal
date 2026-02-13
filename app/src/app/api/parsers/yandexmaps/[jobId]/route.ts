import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getJobIdFromUrl(req: NextRequest) {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const jobId = getJobIdFromUrl(req);
  const { data: job, error } = await supabase
    .from('yandex_maps_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError('Not found', 404);
  return NextResponse.json({ job });
}

export async function PATCH(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const jobId = getJobIdFromUrl(req);
  const { data: updated, error } = await supabase
    .from('yandex_maps_jobs')
    .update({
      status: 'failed',
      error_message: 'Остановлено пользователем',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ job: updated });
}

export async function DELETE(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const jobId = getJobIdFromUrl(req);
  const { error } = await supabase
    .from('yandex_maps_jobs')
    .delete()
    .eq('id', jobId);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}

