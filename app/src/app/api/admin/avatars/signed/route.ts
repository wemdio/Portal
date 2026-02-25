import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAvatarReadUrl } from '@/lib/s3Server';
import { logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function extractKeyFromPublicUrl(url: string): string | null {
  const m = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const key = decodeURIComponent(m[2] ?? '');
  return key && key.startsWith('avatars/') ? key : null;
}

type Body = { userIds?: unknown };

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  const { data: actorProfile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const actorRole = (actorProfile?.role ?? null) as UserRole | null;
  if (!isAdmin(actorRole)) return jsonError('Forbidden', 403);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const rawIds = body.userIds;
  const userIds = Array.isArray(rawIds)
    ? (rawIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  if (userIds.length === 0) {
    return NextResponse.json({ urls: {} });
  }

  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, avatar_url')
    .in('id', userIds);

  if (error) {
    await logError('admin.avatars.signed.fetch.failed', error, { userIds }, logMeta);
    return jsonError('Failed to load profiles', 500);
  }

  const urls: Record<string, string> = {};

  for (const row of profiles ?? []) {
    const id = row?.id;
    const avatarUrl = typeof row?.avatar_url === 'string' ? row.avatar_url.trim() : '';
    if (!id || !avatarUrl) continue;

    const key = extractKeyFromPublicUrl(avatarUrl);
    if (!key) continue;

    try {
      const { readUrl } = await createAvatarReadUrl({ key });
      urls[id] = readUrl;
    } catch (err) {
      await logError('admin.avatars.signed.create.failed', err, { userId: id, key }, logMeta);
    }
  }

  return NextResponse.json({ urls });
}
