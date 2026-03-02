import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/databaseReview/accessGuard';
import { logError, logAudit } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** POST: specialist submits a base tab for review */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  let body: {
    tabId?: string;
    tabName?: string;
    projectId?: string;
    comment?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  if (!body.tabId || typeof body.tabId !== 'string') {
    return jsonError('tabId is required', 400);
  }

  const { data, error } = await auth.supabaseAdmin
    .from('database_review_requests')
    .insert({
      owner_user_id: auth.user.id,
      tab_id: body.tabId,
      tab_name: body.tabName || '',
      project_id: body.projectId || null,
      specialist_comment: body.comment || '',
      status: 'submitted',
    })
    .select('id, status, created_at')
    .single();

  if (error) {
    await logError('database-review.submit.failed', error, { userId: auth.user.id });
    return jsonError(error.message || 'Failed to create review request', 500);
  }

  await logAudit('database-review.submit.success', 'Review request created', {
    requestId: data.id,
    tabId: body.tabId,
  });

  return NextResponse.json({ ok: true, request: data });
}
