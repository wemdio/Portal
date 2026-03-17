import { NextResponse } from 'next/server';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req, user) => {
  const body = await req.json();

  if (body.action === 'list') {
    const data = await instantly.listLeads(body);
    return NextResponse.json(data);
  }

  if (body.action === 'update-interest') {
    const data = await instantly.updateLeadInterestStatus(body);
    return NextResponse.json(data);
  }

  if (body.action === 'move') {
    const data = await instantly.moveLeads(body);
    return NextResponse.json(data);
  }

  if (body.action === 'by-email') {
    const data = await instantly.getLeadsByEmail({ email: body.email });
    return NextResponse.json(data);
  }

  if (body.action === 'delete-by-campaign') {
    const token = getBearerToken(req.headers.get('authorization'));
    const sb = createAuthedSupabaseClient(token!);
    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single();
    if (!profile || profile.role !== 'admin') return jsonError('Только для администраторов', 403);
    if (!body.campaign_id) return jsonError('campaign_id обязателен', 400);
    const result = await instantly.deleteLeadsByCampaign(body.campaign_id);
    return NextResponse.json(result);
  }

  const data = await instantly.createLeads(body.leads, {
    skip_if_in_workspace: body.skip_if_in_workspace,
    skip_if_in_campaign: body.skip_if_in_campaign,
  });
  return NextResponse.json(data, { status: 201 });
});
