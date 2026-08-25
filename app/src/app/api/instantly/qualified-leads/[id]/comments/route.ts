import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  loadAuthorizedQualification,
  qualifiedLeadAccessErrorResponse,
} from '@/lib/instantly/qualifiedLeadAuthorization';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user, params) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const qualificationId = params?.id;
  if (!qualificationId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const authorization = await loadAuthorizedQualification(user.id, qualificationId);
  if (!authorization.ok) return qualifiedLeadAccessErrorResponse(authorization);

  const { data: forwarded } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('id, client_user_id')
    .eq('qualification_id', qualificationId);

  if (!forwarded || forwarded.length === 0) {
    return NextResponse.json({ items: [], forwarded: [] });
  }

  const forwardedIds = forwarded.map((f) => f.id);

  const { data: comments, error } = await supabaseInstantly
    .from('client_lead_comments')
    .select('*')
    .in('forwarded_lead_id', forwardedIds)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    items: comments ?? [],
    forwarded: forwarded.map((f) => ({
      id: f.id,
      client_user_id: f.client_user_id,
    })),
  });
});
