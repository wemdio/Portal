import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/databaseReview/accessGuard';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** GET: fetch row marks for a review request */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { id } = await ctx.params;

  const { data, error } = await auth.supabaseAdmin
    .from('database_review_row_marks')
    .select('*')
    .eq('review_request_id', id)
    .order('row_index', { ascending: true });

  if (error) {
    return jsonError(error.message || 'Failed to fetch marks', 500);
  }

  return NextResponse.json({ marks: data ?? [] });
}

/** POST: upsert a row mark */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { id } = await ctx.params;

  let body: {
    tabId?: string;
    rowIndex?: number;
    color?: string;
    comment?: string;
    authorType?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  if (!body.tabId || body.rowIndex === undefined || body.rowIndex < 0) {
    return jsonError('tabId and rowIndex are required', 400);
  }

  const authorType = body.authorType || 'reviewer';
  if (!['reviewer', 'client', 'specialist'].includes(authorType)) {
    return jsonError('Invalid authorType', 400);
  }

  const { data, error } = await auth.supabaseAdmin
    .from('database_review_row_marks')
    .upsert(
      {
        review_request_id: id,
        tab_id: body.tabId,
        row_index: body.rowIndex,
        color: body.color || '',
        comment: body.comment || '',
        author_type: authorType,
        author_user_id: auth.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'review_request_id,tab_id,row_index,author_type' },
    )
    .select('id, row_index, color, comment, author_type')
    .single();

  if (error) {
    return jsonError(error.message || 'Failed to save mark', 500);
  }

  return NextResponse.json({ ok: true, mark: data });
}
