import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

async function getUser(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  try {
    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { user, supabase } : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await auth.supabase
      .from('profiles')
      .select('default_board_id')
      .eq('id', auth.user.id)
      .single();

    if (error) {
      console.error('[board-preference] GET error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ default_board_id: data?.default_board_id ?? null });
  } catch (err) {
    console.error('[board-preference] GET unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await getUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { default_board_id?: string | null };
    try {
      body = (await req.json()) as { default_board_id?: string | null };
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const boardId = typeof body.default_board_id === 'string' ? body.default_board_id.trim() || null : null;

    const { error } = await auth.supabase
      .from('profiles')
      .update({ default_board_id: boardId })
      .eq('id', auth.user.id);

    if (error) {
      console.error('[board-preference] PUT error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, default_board_id: boardId });
  } catch (err) {
    console.error('[board-preference] PUT unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
