import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';
import { normalizeYandexOrgUrls } from '@/lib/parsers/yandexMapsUrlUtils';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getJobIdFromUrl(req: NextRequest) {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean);
  return parts[parts.length - 2] ?? '';
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const jobId = getJobIdFromUrl(req);

  const { data, error } = await supabase
    .from('yandex_maps_links')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ links: data ?? [] });
}

export async function PUT(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  const jobId = getJobIdFromUrl(req);

  try {
    const body = await req.json();
    const rawLinks = Array.isArray(body?.links) ? body.links.filter((x: unknown) => typeof x === 'string') : [];
    const links = normalizeYandexOrgUrls(rawLinks as string[]);

    await supabase.from('yandex_maps_links').delete().eq('job_id', jobId);
    if (links.length) {
      const rows = links.map((link) => ({ job_id: jobId, link }));
      const { error: insertError } = await supabase.from('yandex_maps_links').insert(rows);
      if (insertError) return jsonError(insertError.message, 500);
    }

    await supabase
      .from('yandex_maps_jobs')
      .update({ total_links: links.length, processed_links: links.length })
      .eq('id', jobId);

    return NextResponse.json({ ok: true, total: links.length });
  } catch (e) {
    console.error('Update links error:', e);
    return jsonError('Internal Server Error', 500);
  }
}

