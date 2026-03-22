import { NextResponse } from 'next/server';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  if (!campaignId) return jsonError('campaign_id is required', 400);

  const leads = await instantly.listAllLeads(campaignId);

  const rows = leads.map((l) => ({
    email: l.email,
    first_name: l.first_name ?? '',
    last_name: l.last_name ?? '',
    company_name: l.company_name ?? '',
    title: l.title ?? '',
    phone: l.phone ?? '',
    website: l.website ?? '',
    interest_status: l.interest_status ?? 0,
    timestamp_created: l.timestamp_created ?? '',
  }));

  return NextResponse.json({ items: rows, total: rows.length });
});
