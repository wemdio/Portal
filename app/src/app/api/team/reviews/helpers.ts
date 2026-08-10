import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { INTERNAL_ROLES, isInternalRole } from '@/lib/roles';
import { checkTeamAccess } from '@/lib/auth/teamAccess';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import {
  hasOwn,
  isValidIsoDate,
  parseUpdatePrecondition,
  pickInputValue as pickValue,
} from '@/lib/apiValidation';
import type { UserRole } from '@/types';

export const REVIEW_TEXT_MAX_LENGTH = 5000;
export const REVIEW_REASON_MAX_LENGTH = 500;
export const REVIEW_CANDIDATE_NAME_MAX_LENGTH = 200;

export type ReviewStatus = 'scheduled' | 'completed';

export const REVIEW_PROJECTION =
  'id, review_date, employee_user_id, candidate_name, reviewer_user_id, status, reason, outcomes, problems, recommendations, created_at, updated_at';

const PROFILE_PROJECTION = 'id, full_name, email, role, avatar_url, is_demo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonError = NextResponse<{ error: string }>;

export type ReviewActor = {
  userId: string;
  canManage: boolean;
};

export type ReviewAuthResult =
  | { actor: ReviewActor }
  | { error: JsonError };

export type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  avatar_url: string | null;
  is_demo: boolean;
};

export type EmployeeReviewRow = {
  id: string;
  review_date: string;
  employee_user_id: string | null;
  candidate_name: string | null;
  reviewer_user_id: string | null;
  status: ReviewStatus | null;
  reason: string | null;
  outcomes: string | null;
  problems: string | null;
  recommendations: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewInput = {
  review_date?: string;
  employee_user_id?: string | null;
  candidate_name?: string | null;
  status?: ReviewStatus;
  reason?: string | null;
  outcomes?: string | null;
  problems?: string | null;
  recommendations?: string | null;
};

export type ReviewUpdatePrecondition = {
  expectedUpdatedAt: string;
};

export function jsonError(message: string, status: number): JsonError {
  return NextResponse.json({ error: message }, { status });
}

export function logMeta(req: NextRequest, userId: string) {
  return {
    userId,
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    route: req.nextUrl.pathname,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };
}

export async function authenticateReviewRequest(
  req: NextRequest,
): Promise<ReviewAuthResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const authedClient = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await authedClient.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const access = await checkTeamAccess(authedClient);
  if (access.error !== null) {
    await logError(
      'team.reviews.auth.failed',
      access.error,
      {},
      logMeta(req, user.id),
    );
    return { error: jsonError('Failed to verify access', 500) };
  }
  if (!access.allowed) {
    return { error: jsonError('Forbidden', 403) };
  }

  return {
    actor: {
      userId: user.id,
      canManage: true,
    },
  };
}

export function parseReviewUpdatePrecondition(
  value: unknown,
): { value: ReviewUpdatePrecondition } | { error: 'missing' | 'invalid' } {
  return parseUpdatePrecondition(value);
}

function parseOptionalText(
  value: unknown,
  field: string,
  maxLength = REVIEW_TEXT_MAX_LENGTH,
): { value: string | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') {
    return { error: `${field} must be a string or null` };
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters` };
  }
  return { value: normalized || null };
}

function validateReviewSubject(
  employeeUserId: string | null | undefined,
  candidateName: string | null | undefined,
): string | null {
  const hasEmployee = typeof employeeUserId === 'string' && employeeUserId.length > 0;
  const hasCandidate = typeof candidateName === 'string' && candidateName.length > 0;
  return hasEmployee === hasCandidate
    ? 'Exactly one of employeeUserId or candidateName is required'
    : null;
}

export function parseReviewInput(
  value: unknown,
  options: { partial: boolean },
): { value: ReviewInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid body' };
  }

  const body = value as Record<string, unknown>;
  const result: ReviewInput = {};

  const reviewDate = pickValue(body, 'reviewDate', 'review_date');
  if (!options.partial || reviewDate.present) {
    if (typeof reviewDate.value !== 'string' || !isValidIsoDate(reviewDate.value)) {
      return { error: 'reviewDate must be a valid YYYY-MM-DD date' };
    }
    result.review_date = reviewDate.value;
  }

  const employeeUserId = pickValue(body, 'employeeUserId', 'employee_user_id');
  if (employeeUserId.present) {
    if (employeeUserId.value === null) {
      result.employee_user_id = null;
    } else if (
      typeof employeeUserId.value !== 'string'
      || !UUID_RE.test(employeeUserId.value)
    ) {
      return { error: 'employeeUserId must be a valid UUID' };
    } else {
      result.employee_user_id = employeeUserId.value;
    }
  }

  const candidateName = pickValue(body, 'candidateName', 'candidate_name');
  if (candidateName.present) {
    const parsed = parseOptionalText(
      candidateName.value,
      'candidateName',
      REVIEW_CANDIDATE_NAME_MAX_LENGTH,
    );
    if ('error' in parsed) return parsed;
    result.candidate_name = parsed.value;
  }

  if (!options.partial) {
    const subjectError = validateReviewSubject(
      result.employee_user_id,
      result.candidate_name,
    );
    if (subjectError) return { error: subjectError };
  }

  const reason = pickValue(body, 'reason', 'reason');
  if (!options.partial || reason.present) {
    const parsed = parseOptionalText(
      reason.value,
      'reason',
      REVIEW_REASON_MAX_LENGTH,
    );
    if ('error' in parsed) return parsed;
    result.reason = parsed.value;
  }

  if (options.partial) {
    const status = pickValue(body, 'status', 'status');
    if (status.present) {
      if (status.value !== 'scheduled' && status.value !== 'completed') {
        return { error: 'status must be scheduled or completed' };
      }
      result.status = status.value;
    }
  }

  const outcomes = pickValue(body, 'outcomes', 'outcomes');
  if (outcomes.present) {
    const parsed = parseOptionalText(outcomes.value, 'outcomes');
    if ('error' in parsed) return parsed;
    result.outcomes = parsed.value;
  }

  for (const [camelKey, snakeKey, dbKey] of [
    ['problems', 'problems', 'problems'],
    ['recommendations', 'recommendations', 'recommendations'],
  ] as const) {
    const field = pickValue(body, camelKey, snakeKey);
    if (!field.present) continue;
    const parsed = parseOptionalText(field.value, camelKey);
    if ('error' in parsed) return parsed;
    result[dbKey] = parsed.value;
  }

  if (options.partial && Object.keys(result).length === 0) {
    return { error: 'At least one review field is required' };
  }

  return { value: result };
}

export function hasReviewResultFields(input: ReviewInput): boolean {
  return (
    hasOwn(input, 'outcomes')
    || hasOwn(input, 'problems')
    || hasOwn(input, 'recommendations')
  );
}

export function normalizeReviewStatus(
  value: unknown,
): ReviewStatus {
  return value === 'scheduled' ? 'scheduled' : 'completed';
}

export function validateReviewUpdate(
  existing: EmployeeReviewRow,
  patch: ReviewInput,
): string | null {
  const nextEmployeeUserId = hasOwn(patch, 'employee_user_id')
    ? patch.employee_user_id ?? null
    : existing.employee_user_id;
  const nextCandidateName = hasOwn(patch, 'candidate_name')
    ? patch.candidate_name ?? null
    : existing.candidate_name;
  const subjectError = validateReviewSubject(
    nextEmployeeUserId,
    nextCandidateName,
  );
  if (subjectError) return subjectError;

  const currentStatus = normalizeReviewStatus(existing.status);
  const nextStatus = patch.status ?? currentStatus;

  if (currentStatus === 'completed' && nextStatus === 'scheduled') {
    return 'Invalid status transition from completed to scheduled';
  }

  const nextOutcomes = hasOwn(patch, 'outcomes')
    ? patch.outcomes ?? null
    : existing.outcomes;
  const nextProblems = hasOwn(patch, 'problems')
    ? patch.problems ?? null
    : existing.problems;
  const nextRecommendations = hasOwn(patch, 'recommendations')
    ? patch.recommendations ?? null
    : existing.recommendations;

  if (
    nextStatus === 'scheduled'
    && (
      nextOutcomes !== null
      || nextProblems !== null
      || nextRecommendations !== null
    )
  ) {
    return 'status must be completed before adding review results';
  }

  if (
    nextStatus === 'completed'
    && (typeof nextOutcomes !== 'string' || !nextOutcomes.trim())
  ) {
    return 'outcomes is required for completed review';
  }

  return null;
}

export async function validateInternalEmployee(
  employeeUserId: string,
): Promise<{ ok: true } | { error: JsonError }> {
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_demo')
    .eq('id', employeeUserId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { error: jsonError('employeeUserId does not reference an employee', 400) };
    }
    return { error: jsonError('Failed to validate employee', 500) };
  }
  if (!data || !isInternalRole(data.role as UserRole | null) || data.is_demo === true) {
    return { error: jsonError('employeeUserId does not reference an employee', 400) };
  }
  return { ok: true };
}

export async function loadInternalProfiles(): Promise<
  { profiles: ProfileRow[] } | { error: JsonError }
> {
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(PROFILE_PROJECTION)
    .in('role', INTERNAL_ROLES)
    .eq('is_demo', false)
    .order('full_name', { ascending: true });

  if (error) return { error: jsonError('Failed to load employees', 500) };
  return { profiles: (data ?? []) as ProfileRow[] };
}

export async function loadReviewProfiles(
  reviews: EmployeeReviewRow[],
  knownProfiles: ProfileRow[],
): Promise<{ profilesById: Map<string, ProfileRow> } | { error: JsonError }> {
  const profilesById = new Map(
    knownProfiles.map((profile) => [profile.id, profile]),
  );
  const referencedIds = new Set<string>();
  for (const review of reviews) {
    if (review.employee_user_id) referencedIds.add(review.employee_user_id);
    if (review.reviewer_user_id) referencedIds.add(review.reviewer_user_id);
  }
  const missingIds = Array.from(referencedIds).filter(
    (profileId) => !profilesById.has(profileId),
  );
  if (missingIds.length === 0) return { profilesById };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(PROFILE_PROJECTION)
    .in('id', missingIds);

  if (error) return { error: jsonError('Failed to load review profiles', 500) };
  for (const profile of (data ?? []) as ProfileRow[]) {
    profilesById.set(profile.id, profile);
  }
  return { profilesById };
}

export function profileToApi(profile: ProfileRow) {
  return {
    id: profile.id,
    name: profile.full_name?.trim() || profile.email || 'Сотрудник',
    email: profile.email,
    role: profile.role,
    avatarUrl: profile.avatar_url,
  };
}

export function reviewToApi(
  review: EmployeeReviewRow,
  profilesById: Map<string, ProfileRow>,
) {
  const employee = review.employee_user_id
    ? profilesById.get(review.employee_user_id)
    : null;
  const reviewer = review.reviewer_user_id
    ? profilesById.get(review.reviewer_user_id)
    : null;

  return {
    id: review.id,
    reviewDate: review.review_date,
    employee: employee ? profileToApi(employee) : null,
    candidateName: review.candidate_name?.trim() || null,
    reviewer: reviewer ? profileToApi(reviewer) : null,
    status: normalizeReviewStatus(review.status),
    reason: review.reason ?? null,
    outcomes: review.outcomes ?? null,
    problems: review.problems,
    recommendations: review.recommendations,
    createdAt: review.created_at ?? null,
    updatedAt: review.updated_at ?? null,
  };
}
