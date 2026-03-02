import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyGuestToken, hashGuestToken } from '@/lib/databaseReview/guestToken';

export const dynamic = 'force-dynamic';

const GUEST_TOKEN_SECRET = process.env.GUEST_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-secret';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function validateToken(token: string) {
  const result = verifyGuestToken(token, GUEST_TOKEN_SECRET);
  if (!result.ok) return { error: jsonError(result.error, 401) };
  return { payload: result.payload };
}

/** GET: read-only base data for guest */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { token } = await ctx.params;
  const decodedToken = decodeURIComponent(token);
  const v = validateToken(decodedToken);
  if ('error' in v) return v.error;

  const tokenHash = hashGuestToken(decodedToken, GUEST_TOKEN_SECRET);

  const { data: reviewReq, error: reqErr } = await supabaseAdmin
    .from('database_review_requests')
    .select('id, owner_user_id, tab_id, tab_name, project_id, status, specialist_comment, guest_token_hash, guest_token_expires_at')
    .eq('id', v.payload.rid)
    .single();

  if (reqErr || !reviewReq) return jsonError('Review request not found', 404);

  if (reviewReq.guest_token_hash !== tokenHash) {
    return jsonError('Token revoked', 401);
  }

  const { data: stateRow } = await supabaseAdmin
    .from('database_spreadsheet_states')
    .select('state')
    .eq('user_id', reviewReq.owner_user_id)
    .maybeSingle();

  const state = stateRow?.state as { tabs?: Array<{ id: string; name: string; data: string[][] }> } | null;
  const tab = state?.tabs?.find((t) => t.id === reviewReq.tab_id) ?? null;

  const { data: marks } = await supabaseAdmin
    .from('database_review_row_marks')
    .select('id, tab_id, row_index, color, comment, author_type, created_at')
    .eq('review_request_id', reviewReq.id)
    .order('row_index', { ascending: true });

  return NextResponse.json({
    request: {
      id: reviewReq.id,
      tabId: reviewReq.tab_id,
      tabName: reviewReq.tab_name,
      status: reviewReq.status,
    },
    tab: tab ? { id: tab.id, name: tab.name, data: tab.data } : null,
    marks: marks ?? [],
  });
}

/** POST: guest submits a row mark (comment + color) */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { token } = await ctx.params;
  const decodedToken = decodeURIComponent(token);
  const v = validateToken(decodedToken);
  if ('error' in v) return v.error;

  const tokenHash = hashGuestToken(decodedToken, GUEST_TOKEN_SECRET);

  const { data: reviewReq } = await supabaseAdmin
    .from('database_review_requests')
    .select('id, tab_id, status, guest_token_hash')
    .eq('id', v.payload.rid)
    .single();

  if (!reviewReq || reviewReq.guest_token_hash !== tokenHash) {
    return jsonError('Token invalid or revoked', 401);
  }

  if (reviewReq.status !== 'client_requested_changes' && reviewReq.status !== 'sent_to_client') {
    return jsonError('Review is no longer accepting feedback', 400);
  }

  let body: { tabId?: string; rowIndex?: number; color?: string; comment?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  if (!body.tabId || body.rowIndex === undefined || body.rowIndex < 0) {
    return jsonError('tabId and rowIndex are required', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('database_review_row_marks')
    .upsert(
      {
        review_request_id: reviewReq.id,
        tab_id: body.tabId,
        row_index: body.rowIndex,
        color: body.color || '',
        comment: body.comment || '',
        author_type: 'client',
        author_user_id: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'review_request_id,tab_id,row_index,author_type' },
    )
    .select('id, row_index, color, comment')
    .single();

  if (error) {
    return jsonError(error.message || 'Failed to save mark', 500);
  }

  return NextResponse.json({ ok: true, mark: data });
}
