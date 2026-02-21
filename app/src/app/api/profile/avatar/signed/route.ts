import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { createAvatarReadUrl } from '@/lib/s3Server';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function extractKeyFromPublicUrl(url: string): { bucket: string; key: string } | null {
  // https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<key>
  const m = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const bucket = decodeURIComponent(m[1] ?? '');
  const key = decodeURIComponent(m[2] ?? '');
  if (!bucket || !key) return null;
  return { bucket, key };
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .single();

    if (error) throw error;

    const avatarUrl = typeof profile?.avatar_url === 'string' ? profile.avatar_url.trim() : '';
    if (!avatarUrl) return jsonError('Missing avatar', 404);

    const extracted = extractKeyFromPublicUrl(avatarUrl);
    if (!extracted) return jsonError('Invalid avatar url', 400);

    // Safety: allow only our avatars prefix
    if (!extracted.key.startsWith('avatars/')) return jsonError('Invalid avatar key', 400);

    const { readUrl, key } = await createAvatarReadUrl({ key: extracted.key });
    await logAudit('profile.avatar.signed.success', 'Signed avatar url created', { key }, logMeta);
    return NextResponse.json({ ok: true, readUrl, key });
  } catch (err) {
    await logError('profile.avatar.signed.failed', err, {}, logMeta);
    return jsonError('Failed to create signed url', 500);
  }
}

