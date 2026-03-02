import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireDatabaseReviewAccess } from '@/lib/databaseReview/accessGuard';
import { canTransition, type ReviewStatus } from '@/lib/databaseReview/statusTransitions';
import { logError, logAudit } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** POST: reviewer decides on a review request */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireDatabaseReviewAccess(req);
  if ('error' in auth) return auth.error;

  const { id } = await ctx.params;

  let body: { decision?: string; comment?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const decision = body.decision as ReviewStatus | undefined;
  if (!decision) return jsonError('decision is required', 400);

  const { data: existing, error: fetchErr } = await auth.supabaseAdmin
    .from('database_review_requests')
    .select('status')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) return jsonError('Request not found', 404);

  const currentStatus = existing.status as ReviewStatus;
  if (!canTransition(currentStatus, decision)) {
    return jsonError(`Cannot transition from ${currentStatus} to ${decision}`, 400);
  }

  const update: Record<string, unknown> = {
    status: decision,
    reviewer_user_id: auth.user.id,
    updated_at: new Date().toISOString(),
  };
  if (body.comment !== undefined) {
    update.reviewer_comment = body.comment;
  }

  const { error: updateErr } = await auth.supabaseAdmin
    .from('database_review_requests')
    .update(update)
    .eq('id', id);

  if (updateErr) {
    await logError('database-review.decide.failed', updateErr, { requestId: id });
    return jsonError(updateErr.message || 'Failed to update', 500);
  }

  await logAudit('database-review.decide.success', `Review decision: ${decision}`, {
    requestId: id,
    decision,
  });

  return NextResponse.json({ ok: true, status: decision });
}
