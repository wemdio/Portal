import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req) => {
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

  const data = await instantly.createLeads(body.leads, {
    skip_if_in_workspace: body.skip_if_in_workspace,
    skip_if_in_campaign: body.skip_if_in_campaign,
  });
  return NextResponse.json(data, { status: 201 });
});
