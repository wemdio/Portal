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
    return user ? { user, supabase, token } : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await auth.supabase
      .from('user_instantly_campaign_preferences')
      .select('campaign_id, created_at')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[campaign-preferences] GET error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      campaign_ids: (data ?? []).map((r) => r.campaign_id),
    });
  } catch (err) {
    console.error('[campaign-preferences] GET unexpected error:', err);
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

    let body: { campaign_ids?: string[] };
    try {
      body = (await req.json()) as { campaign_ids?: string[] };
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const campaignIds = Array.isArray(body.campaign_ids)
      ? body.campaign_ids.filter(
          (s): s is string => typeof s === 'string' && s.trim().length > 0,
        )
      : [];

    const { error: delErr } = await auth.supabase
      .from('user_instantly_campaign_preferences')
      .delete()
      .eq('user_id', auth.user.id);

    if (delErr) {
      console.error('[campaign-preferences] DELETE error:', delErr);
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    if (campaignIds.length > 0) {
      const rows = campaignIds.map((id) => ({
        user_id: auth.user.id,
        campaign_id: id.trim(),
      }));
      const { error: insErr } = await auth.supabase
        .from('user_instantly_campaign_preferences')
        .insert(rows);
      if (insErr) {
        console.error('[campaign-preferences] INSERT error:', insErr);
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, count: campaignIds.length });
  } catch (err) {
    console.error('[campaign-preferences] PUT unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
