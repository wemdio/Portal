import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { collectPages } from '@/lib/collectPages';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequest,
  hasReviewResultFields,
  jsonError,
  loadInternalProfiles,
  logMeta,
  parseReviewInput,
  profileToApi,
  REVIEW_PROJECTION,
  reviewToApi,
  validateInternalEmployee,
  type EmployeeReviewRow,
} from './helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateReviewRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;
  const admin = supabaseAdmin;
  let reviewsData: EmployeeReviewRow[];
  try {
    reviewsData = await collectPages(async (from, to) => {
      const query = admin
        .from('employee_reviews')
        .select(REVIEW_PROJECTION);

      const page = await query
        .order('review_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to);

      return {
        data: (page.data ?? []) as EmployeeReviewRow[],
        error: page.error ? { message: page.error.message } : null,
      };
    });
  } catch (reviewsError) {
    await logError(
      'team.reviews.list.failed',
      reviewsError,
      {},
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load reviews', 500);
  }

  const profileResult = await loadInternalProfiles();
  if ('error' in profileResult) return profileResult.error;

  const profilesById = new Map(
    profileResult.profiles.map((profile) => [profile.id, profile]),
  );
  const visibleEmployees = profileResult.profiles;

  return NextResponse.json({
    reviews: reviewsData.map((review) =>
      reviewToApi(review, profilesById),
    ),
    employees: visibleEmployees.map(profileToApi),
    canManage: actor.canManage,
    currentUserId: actor.userId,
  });
}

export async function POST(req: NextRequest) {
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

  const parsed = parseReviewInput(body, { partial: false });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const completesReview = hasReviewResultFields(parsed.value);
  if (completesReview && !parsed.value.outcomes) {
    return jsonError('outcomes is required for completed review', 400);
  }

  const employeeUserId = parsed.value.employee_user_id!;
  const employeeValidation = await validateInternalEmployee(employeeUserId);
  if ('error' in employeeValidation) return employeeValidation.error;

  const row = {
    review_date: parsed.value.review_date!,
    employee_user_id: employeeUserId,
    reviewer_user_id: actor.userId,
    status: completesReview ? 'completed' as const : 'scheduled' as const,
    reason: parsed.value.reason ?? null,
    outcomes: parsed.value.outcomes ?? null,
    problems: parsed.value.problems ?? null,
    recommendations: parsed.value.recommendations ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from('employee_reviews')
    .insert(row)
    .select(REVIEW_PROJECTION)
    .single();

  if (error || !data) {
    await logError(
      'team.reviews.create.failed',
      error ?? new Error('Review insert returned no row'),
      { employeeUserId },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to create review', 500);
  }

  const profileResult = await loadInternalProfiles();
  if ('error' in profileResult) return profileResult.error;
  const profilesById = new Map(
    profileResult.profiles.map((profile) => [profile.id, profile]),
  );

  await logAudit(
    'team.reviews.create.success',
    'Employee review created',
    {
      reviewId: data.id,
      employeeUserId,
      reviewDate: row.review_date,
    },
    logMeta(req, actor.userId),
  );

  return NextResponse.json(
    { review: reviewToApi(data as EmployeeReviewRow, profilesById) },
    { status: 201 },
  );
}
