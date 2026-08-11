import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isValidUuid } from '@/lib/apiValidation';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequestInbox,
  jsonError,
  logMeta,
  parseReviewRequestActionInput,
  parseReviewRequestPrecondition,
} from '../helpers';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function preconditionError(error: 'missing' | 'invalid') {
  return error === 'missing'
    ? jsonError(
        'expectedUpdatedAt is required',
        428,
        'precondition_required',
      )
    : jsonError(
        'expectedUpdatedAt must be a valid RFC 3339 timestamp',
        400,
        'invalid_precondition',
      );
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await authenticateReviewRequestInbox(req, 'private');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { actor } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const precondition = parseReviewRequestPrecondition(body);
  if ('error' in precondition) return preconditionError(precondition.error);

  const parsed = parseReviewRequestActionInput(body);
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const { id } = await context.params;
  if (!isValidUuid(id)) return jsonError('Invalid review request id', 400);

  const now = new Date().toISOString();
  const patch = parsed.value.action === 'claim'
    ? {
        state: 'in_progress' as const,
        claimed_by: actor.userId,
        claimed_at: now,
        updated_by: actor.userId,
      }
    : {
        state: 'declined' as const,
        decision_note: parsed.value.decision_note,
        resolved_by: actor.userId,
        resolved_at: now,
        updated_by: actor.userId,
      };

  let update = supabaseAdmin
    .from('team_review_requests')
    .update(patch)
    .eq('id', id)
    .eq('updated_at', precondition.value.expectedUpdatedAt);
  update = parsed.value.action === 'claim'
    ? update.eq('state', 'new')
    : update.in('state', ['new', 'in_progress']);

  const { data: updated, error } = await update
    .select('id')
    .maybeSingle();

  if (error) {
    await logError(
      'team.review_requests.update.failed',
      error,
      { requestId: id, action: parsed.value.action },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to update review request', 500);
  }

  if (!updated) {
    const { data: current, error: reloadError } = await supabaseAdmin
      .from('team_review_requests')
      .select('id, state, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (reloadError) {
      await logError(
        'team.review_requests.conflict_reload.failed',
        reloadError,
        { requestId: id, action: parsed.value.action },
        logMeta(req, actor.userId),
      );
      return jsonError('Failed to verify review request update', 500);
    }
    if (!current) return jsonError('Review request not found', 404);
    return NextResponse.json(
      {
        error: 'Review request was changed by another user. Reload it and try again.',
        code: 'review_request_conflict',
        currentUpdatedAt: current.updated_at,
        currentState: current.state,
      },
      { status: 409 },
    );
  }

  await logAudit(
    'team.review_requests.update.success',
    'Team review request updated',
    { requestId: id, action: parsed.value.action },
    logMeta(req, actor.userId),
  );

  return NextResponse.json({
    request: {
      id,
      state: patch.state,
    },
  });
}
