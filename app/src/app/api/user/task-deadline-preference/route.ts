import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

type DeadlineMode = 'tomorrow' | 'fixed';

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
      .select('task_deadline_default_enabled, task_deadline_default_mode, task_deadline_default_at, task_deadline_default_time')
      .eq('id', auth.user.id)
      .single();

    if (error) {
      console.error('[task-deadline-preference] GET error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      enabled: Boolean(data?.task_deadline_default_enabled),
      mode: (data?.task_deadline_default_mode === 'fixed' ? 'fixed' : 'tomorrow') as DeadlineMode,
      at: data?.task_deadline_default_at ?? null,
      time: data?.task_deadline_default_time ?? '12:00',
    });
  } catch (err) {
    console.error('[task-deadline-preference] GET unexpected error:', err);
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

    let body: { enabled?: boolean; mode?: DeadlineMode; at?: string | null; time?: string | null };
    try {
      body = (await req.json()) as { enabled?: boolean; mode?: DeadlineMode; at?: string | null; time?: string | null };
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const enabled = Boolean(body.enabled);
    const mode: DeadlineMode = body.mode === 'fixed' ? 'fixed' : 'tomorrow';
    const atRaw = typeof body.at === 'string' ? body.at.trim() : '';
    const timeRaw = typeof body.time === 'string' ? body.time.trim() : '';
    const validTime = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw) ? timeRaw : '12:00';
    const at = atRaw ? new Date(atRaw) : null;

    if (mode === 'fixed' && (!at || Number.isNaN(at.getTime()))) {
      return NextResponse.json({ error: 'Invalid fixed deadline value' }, { status: 400 });
    }

    const { error } = await auth.supabase
      .from('profiles')
      .update({
        task_deadline_default_enabled: enabled,
        task_deadline_default_mode: mode,
        task_deadline_default_at: mode === 'fixed' && at ? at.toISOString() : null,
        task_deadline_default_time: mode === 'tomorrow' ? validTime : null,
      })
      .eq('id', auth.user.id);

    if (error) {
      console.error('[task-deadline-preference] PUT error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      enabled,
      mode,
      at: mode === 'fixed' && at ? at.toISOString() : null,
      time: mode === 'tomorrow' ? validTime : null,
    });
  } catch (err) {
    console.error('[task-deadline-preference] PUT unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
