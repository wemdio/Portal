import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { createAvatarReadUrl } from '@/lib/s3Server';

export const dynamic = 'force-dynamic';

function extractKeyFromPublicUrl(url: string): string | null {
  const clean = url.split(/[?#]/)[0] ?? '';
  const m = clean.match(/\/storage\/v1\/object\/public\/[^/]+\/(.+)$/i);
  if (!m) return null;
  const key = decodeURIComponent(m[1] ?? '');
  return key && key.startsWith('avatars/') ? key : null;
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('email, full_name, avatar_url');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result: Record<string, string> = {};

  await Promise.all(
    (profiles ?? []).map(async (p) => {
      const name = (p.full_name as string)?.trim() || (p.email as string)?.split('@')[0]?.trim();
      const rawUrl = typeof p.avatar_url === 'string' ? p.avatar_url.trim() : '';
      if (!name || !rawUrl) return;

      const key = extractKeyFromPublicUrl(rawUrl);
      if (!key) return;

      try {
        const { readUrl } = await createAvatarReadUrl({ key });
        result[name] = readUrl;
      } catch (err) {
        console.error(`[avatars] Failed to sign ${key}:`, err);
      }
    }),
  );

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'private, max-age=1800' },
  });
}
