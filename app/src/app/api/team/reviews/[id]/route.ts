import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequest,
  jsonError,
  loadInternalProfiles,
  loadReviewProfiles,
  logMeta,
  parseReviewInput,
  parseReviewUpdatePrecondition,
  REVIEW_PROJECTION,
  reviewToApi,
  validateInternalEmployee,
  validateReviewUpdate,
  type EmployeeReviewRow,
} from '../helpers';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function preconditionError(
  message: string,
  status: 400 | 409 | 428,
  code: 'invalid_precondition' | 'precondition_required' | 'review_conflict',
  details: Record<string, unknown> = {},
) {
  return NextResponse.json({ error: message, code, ...details }, { status });
}

function reviewConflict(currentUpdatedAt: string) {
  return preconditionError(
    'Review was changed by another user. Reload it and try again.',
    409,
    'review_conflict',
    { currentUpdatedAt },
  );
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await authenticateReviewRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const precondition = parseReviewUpdatePrecondition(body);
  if ('error' in precondition) {
    return precondition.error === 'missing'
      ? preconditionError(
          'expectedUpdatedAt is required',
          428,
          'precondition_required',
        )
      : preconditionError(
          'expectedUpdatedAt must be a valid RFC 3339 timestamp',
          400,
          'invalid_precondition',
        );
  }

  const parsed = parseReviewInput(body, { partial: true });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const { id } = await context.params;

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('employee_reviews')
    .select(REVIEW_PROJECTION)
    .eq('id', id)
    .maybeSingle();

  if (existingError) {
    await logError(
      'team.reviews.update.read.failed',
      existingError,
      { reviewId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load review', 500);
  }
  if (!existing) return jsonError('Review not found', 404);
  const existingReview = existing as EmployeeReviewRow;

  const expectedUpdatedAt = precondition.value.expectedUpdatedAt;
  if (existing.updated_at !== expectedUpdatedAt) {
    return reviewConflict(existing.updated_at);
  }

  const selectedEmployeeUserId = parsed.value.employee_user_id;
  if (
    typeof selectedEmployeeUserId === 'string'
    && selectedEmployeeUserId !== existingReview.employee_user_id
  ) {
    const employeeValidation = await validateInternalEmployee(
      selectedEmployeeUserId,
    );
    if ('error' in employeeValidation) return employeeValidation.error;
  }

  const lifecycleError = validateReviewUpdate(
    existingReview,
    parsed.value,
  );
  if (lifecycleError) return jsonError(lifecycleError, 400);

  const { data: updatedMatch, error: updateError } = await supabaseAdmin
    .from('employee_reviews')
    .update(parsed.value)
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id')
    .maybeSingle();

  if (updateError) {
    await logError(
      'team.reviews.update.failed',
      updateError,
      { reviewId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to update review', 500);
  }

  if (!updatedMatch) {
    const { data: current, error: currentError } = await supabaseAdmin
      .from('employee_reviews')
      .select('id, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (currentError) {
      await logError(
        'team.reviews.update.conflict_reload.failed',
        currentError,
        { reviewId: id },
        logMeta(req, actor.userId),
      );
      return jsonError('Failed to verify review update', 500);
    }
    if (!current) return jsonError('Review not found', 404);
    return reviewConflict(String(current.updated_at));
  }

  const { data: updated, error: updatedError } = await supabaseAdmin
    .from('employee_reviews')
    .select(REVIEW_PROJECTION)
    .eq('id', id)
    .single();

  if (updatedError || !updated) {
    await logError(
      'team.reviews.update.reload.failed',
      updatedError ?? new Error('Review update returned no row'),
      { reviewId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load updated review', 500);
  }

  const profileResult = await loadInternalProfiles();
  if ('error' in profileResult) return profileResult.error;
  const reviewProfilesResult = await loadReviewProfiles(
    [updated as EmployeeReviewRow],
    profileResult.profiles,
  );
  if ('error' in reviewProfilesResult) return reviewProfilesResult.error;

  await logAudit(
    'team.reviews.update.success',
    'Employee review updated',
    {
      reviewId: id,
      changedFields: Object.keys(parsed.value),
    },
    logMeta(req, actor.userId),
  );

  return NextResponse.json({
    review: reviewToApi(
      updated as EmployeeReviewRow,
      reviewProfilesResult.profilesById,
    ),
  });
}
