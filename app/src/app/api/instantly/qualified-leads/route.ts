import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const token = getBearerToken(req.headers.get('authorization'))!;
  const supabase = createAuthedSupabaseClient(token);

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const campaignId = url.searchParams.get('campaign_id');
  const search = url.searchParams.get('search');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const usePreferences = url.searchParams.get('use_preferences') !== 'false';

  let query = supabase
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
  } else if (usePreferences) {
    const { data: prefs } = await supabase
      .from('user_instantly_campaign_preferences')
      .select('campaign_id');

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

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  });
});
