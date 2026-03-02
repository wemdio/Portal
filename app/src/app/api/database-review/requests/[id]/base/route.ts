import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/databaseReview/accessGuard';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** GET: fetch the live base data for a review request (reviewer reads owner's spreadsheet state) */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { id } = await ctx.params;

  const { data: reviewReq, error: reqErr } = await auth.supabaseAdmin
    .from('database_review_requests')
    .select('owner_user_id, tab_id, tab_name, project_id, status, specialist_comment, reviewer_comment')
    .eq('id', id)
    .single();

  if (reqErr || !reviewReq) return jsonError('Request not found', 404);

  const { data: stateRow, error: stateErr } = await auth.supabaseAdmin
    .from('database_spreadsheet_states')
    .select('state')
    .eq('user_id', reviewReq.owner_user_id)
    .maybeSingle();

  if (stateErr) {
    return jsonError(stateErr.message || 'Failed to fetch base data', 500);
  }

  const state = stateRow?.state as { tabs?: Array<{ id: string; name: string; data: string[][] }> } | null;
  const tab = state?.tabs?.find((t) => t.id === reviewReq.tab_id) ?? null;

  return NextResponse.json({
    request: reviewReq,
    tab: tab ? { id: tab.id, name: tab.name, data: tab.data } : null,
  });
}
