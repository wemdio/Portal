import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export const DELETE = withAuth(async (_req, user, params) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const briefId = params?.id;
  if (!briefId) {
    return NextResponse.json({ error: 'brief id required' }, { status: 400 });
  }

  const { data: existing } = await supabaseInstantly
    .from('instantly_briefs')
    .select('id')
    .eq('id', briefId)
    .eq('uploaded_by', user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
  }

  const { error } = await supabaseInstantly
    .from('instantly_briefs')
    .delete()
    .eq('id', briefId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
});
