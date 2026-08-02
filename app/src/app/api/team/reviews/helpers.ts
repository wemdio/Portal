import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { INTERNAL_ROLES, isInternalRole, isLead } from '@/lib/roles';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { UserRole } from '@/types';

export const REVIEW_TEXT_MAX_LENGTH = 5000;
export const REVIEW_REASON_MAX_LENGTH = 500;

export type ReviewStatus = 'scheduled' | 'completed';

export const REVIEW_PROJECTION =
  'id, review_date, employee_user_id, reviewer_user_id, status, reason, outcomes, problems, recommendations, created_at, updated_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonError = NextResponse<{ error: string }>;

export type ReviewActor = {
  userId: string;
  role: UserRole;
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
  employee_user_id: string;
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
  employee_user_id?: string;
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

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('role, is_demo')
    .eq('id', user.id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return { error: jsonError('Forbidden', 403) };
    await logError(
      'team.reviews.auth.failed',
      error,
      {},
      logMeta(req, user.id),
    );
    return { error: jsonError('Failed to verify access', 500) };
  }

  const role = (data?.role ?? null) as UserRole | null;
  if (!isLead(role) || data?.is_demo === true) {
    return { error: jsonError('Forbidden', 403) };
  }

  return {
    actor: {
      userId: user.id,
      role: role as UserRole,
      canManage: true,
    },
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function pickValue(
  body: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): { present: boolean; value: unknown } {
  if (hasOwn(body, camelKey)) return { present: true, value: body[camelKey] };
  if (hasOwn(body, snakeKey)) return { present: true, value: body[snakeKey] };
  return { present: false, value: undefined };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

function isValidRfc3339Timestamp(value: string): boolean {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match || !isValidIsoDate(match[1])) return false;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[7] ? Number(match[7]) : 0;
  const offsetMinute = match[8] ? Number(match[8]) : 0;

  return (
    hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 14
    && offsetMinute <= 59
    && (offsetHour < 14 || offsetMinute === 0)
    && Number.isFinite(Date.parse(value))
  );
}

export function parseReviewUpdatePrecondition(
  value: unknown,
): { value: ReviewUpdatePrecondition } | { error: 'missing' | 'invalid' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'invalid' };
  }

  const body = value as Record<string, unknown>;
  const field = pickValue(body, 'expectedUpdatedAt', 'expected_updated_at');
  if (!field.present) return { error: 'missing' };
  if (
    typeof field.value !== 'string'
    || !isValidRfc3339Timestamp(field.value)
  ) {
    return { error: 'invalid' };
  }

  return { value: { expectedUpdatedAt: field.value } };
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
  if (!options.partial || employeeUserId.present) {
    if (
      typeof employeeUserId.value !== 'string'
      || !UUID_RE.test(employeeUserId.value)
    ) {
      return { error: 'employeeUserId must be a valid UUID' };
    }
    result.employee_user_id = employeeUserId.value;
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
    .select('id, full_name, email, role, avatar_url, is_demo')
    .in('role', INTERNAL_ROLES)
    .eq('is_demo', false)
    .order('full_name', { ascending: true });

  if (error) return { error: jsonError('Failed to load employees', 500) };
  return { profiles: (data ?? []) as ProfileRow[] };
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
  const employee = profilesById.get(review.employee_user_id);
  const reviewer = review.reviewer_user_id
    ? profilesById.get(review.reviewer_user_id)
    : null;

  return {
    id: review.id,
    reviewDate: review.review_date,
    employee: employee ? profileToApi(employee) : null,
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
