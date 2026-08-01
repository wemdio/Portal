import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequest,
  jsonError,
  loadInternalProfiles,
  logMeta,
  parseReviewInput,
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

  const parsed = parseReviewInput(body, { partial: true });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  if (parsed.value.employee_user_id) {
    const employeeValidation = await validateInternalEmployee(
      parsed.value.employee_user_id,
    );
    if ('error' in employeeValidation) return employeeValidation.error;
  }

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

  const lifecycleError = validateReviewUpdate(
    existing as EmployeeReviewRow,
    parsed.value,
  );
  if (lifecycleError) return jsonError(lifecycleError, 400);

  const { error: updateError } = await supabaseAdmin
    .from('employee_reviews')
    .update(parsed.value)
    .eq('id', id);

  if (updateError) {
    await logError(
      'team.reviews.update.failed',
      updateError,
      { reviewId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to update review', 500);
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
  const profilesById = new Map(
    profileResult.profiles.map((profile) => [profile.id, profile]),
  );

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
    review: reviewToApi(updated as EmployeeReviewRow, profilesById),
  });
}
