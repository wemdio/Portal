import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const briefId = params?.id;
  if (!briefId) {
    return NextResponse.json({ error: 'brief id required' }, { status: 400 });
  }

  const { data, error } = await supabaseInstantly
    .from('instantly_brief_campaigns')
    .select('id, campaign_id')
    .eq('brief_id', briefId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
});

export const PUT = withAuth(async (req, user, params) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const briefId = params?.id;
  if (!briefId) {
    return NextResponse.json({ error: 'brief id required' }, { status: 400 });
  }

  const { data: brief } = await supabaseInstantly
    .from('instantly_briefs')
    .select('id')
    .eq('id', briefId)
    .eq('uploaded_by', user.id)
    .single();

  if (!brief) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
  }

  const body = (await req.json()) as { campaign_ids?: string[] };
  const campaignIds = body.campaign_ids ?? [];

  const { error: delError } = await supabaseInstantly
    .from('instantly_brief_campaigns')
    .delete()
    .eq('brief_id', briefId);

  if (delError) {
    return NextResponse.json({ error: delError.message }, { status: 500 });
  }

  if (campaignIds.length > 0) {
    const rows = campaignIds.map((cid) => ({
      brief_id: briefId,
      campaign_id: cid,
    }));

    const { error: insError } = await supabaseInstantly
      .from('instantly_brief_campaigns')
      .insert(rows);

    if (insError) {
      return NextResponse.json({ error: insError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, count: campaignIds.length });
});
