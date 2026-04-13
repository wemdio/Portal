import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export const PATCH = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await req.json() as { ids?: string[] };
  const ids = body.ids;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 });
  }

  const { error } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .update({ read_at: new Date().toISOString(), read_by: user.id })
    .in('id', ids)
    .is('read_at', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
});

export const GET = withAuth(async (req) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const token = getBearerToken(req.headers.get('authorization'))!;
  const authClient = createAuthedSupabaseClient(token);
  const { data: { user } } = await authClient.auth.getUser();

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const campaignId = url.searchParams.get('campaign_id');
  const search = url.searchParams.get('search');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const usePreferences = url.searchParams.get('use_preferences') !== 'false';

  let query = supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status && status !== 'all') {
    query = query.eq('status', status);
  } else {
    query = query.neq('status', 'pending');
  }

  if (campaignId) {
    query = query.eq('campaign_id', campaignId);
  } else if (usePreferences && user) {
    const { data: prefs } = await supabaseInstantly
      .from('user_instantly_campaign_preferences')
      .select('campaign_id')
      .eq('user_id', user.id);

    if (prefs && prefs.length > 0) {
      const campaignIds = prefs.map((p) => p.campaign_id);
      query = query.in('campaign_id', campaignIds);
    }
  }

  if (search) {
    query = query.or(
      `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
    );
  }

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Build status counts with the same campaign/preference/search filters
  let prefCampaignIds: string[] | null = null;
  if (campaignId) {
    prefCampaignIds = [campaignId];
  } else if (usePreferences && user) {
    const { data: prefs } = await supabaseInstantly
      .from('user_instantly_campaign_preferences')
      .select('campaign_id')
      .eq('user_id', user.id);
    if (prefs && prefs.length > 0) prefCampaignIds = prefs.map((p) => p.campaign_id);
  }

  const statuses = ['lead', 'objection', 'needs_review', 'not_lead', 'error'] as const;
  const counts: Record<string, number> = {};

  await Promise.all(
    statuses.map(async (s) => {
      let cq = supabaseInstantly!
        .from('instantly_lead_qualifications')
        .select('*', { count: 'exact', head: true })
        .eq('status', s);

      if (prefCampaignIds) cq = cq.in('campaign_id', prefCampaignIds);

      if (search) {
        cq = cq.or(
          `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
        );
      }

      const { count: c } = await cq;
      counts[s] = c ?? 0;
    }),
  );

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    limit,
    offset,
    counts,
  });
});
