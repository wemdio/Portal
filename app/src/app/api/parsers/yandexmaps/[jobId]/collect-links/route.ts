import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { runYandexMapsCollectLinks } from '@/lib/parsers/yandexMapsWorker';

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

  const jobId = getJobIdFromUrl(req);
  const { data: job, error } = await supabase
    .from('yandex_maps_jobs')
    .select('id')
    .eq('id', jobId)
    .single();

  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError('Not found', 404);

  runYandexMapsCollectLinks(jobId).catch((e) => {
    console.error('Failed to run yandexmaps collect-links job:', e);
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}

