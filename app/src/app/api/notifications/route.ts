import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

async function getUser(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  try {
    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    return user ? { user, supabase } : null;
  } catch {
    return null;
  }
}

/** GET /api/notifications — list current user's notifications */
export async function GET(req: NextRequest) {
  const auth = await getUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await auth.supabase
    .from('notifications')
    .select('*')
    .eq('user_id', auth.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { count } = await auth.supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', auth.user.id)
    .eq('is_read', false);

  return NextResponse.json({ notifications: data ?? [], unread_count: count ?? 0 });
}

/** PATCH /api/notifications — mark notifications as read */
export async function PATCH(req: NextRequest) {
  const auth = await getUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const ids: string[] | undefined = body.ids;

  if (ids && Array.isArray(ids) && ids.length > 0) {
    const { error } = await auth.supabase
      .from('notifications')
      .update({ is_read: true })
      .in('id', ids)
      .eq('user_id', auth.user.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await auth.supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', auth.user.id)
      .eq('is_read', false);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
