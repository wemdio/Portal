import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  checkTeamAccess,
  checkTeamReviewRequestSubmitAccess,
} from '@/lib/auth/teamAccess';
import { collectPages } from '@/lib/collectPages';
import {
  isValidIsoDate,
  isValidUuid,
  parseUpdatePrecondition,
  pickInputValue,
  type UpdatePrecondition,
} from '@/lib/apiValidation';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { formatTeamProjectLabel } from '@/lib/teamProjectLabel';
import {
  loadInternalProfiles,
  profileToApi,
  validateInternalEmployee,
  type ProfileRow,
} from '../reviews/helpers';

export const REVIEW_REQUEST_PROBLEM_MAX_LENGTH = 500;
export const REVIEW_REQUEST_EXAMPLES_MAX_LENGTH = 5000;
export const REVIEW_REQUEST_OUTCOME_MAX_LENGTH = 1000;
export const REVIEW_REQUEST_DECISION_MAX_LENGTH = 1000;
export const REVIEW_REQUEST_REASON_MAX_LENGTH = 500;

export const REVIEW_REQUEST_STATES = [
  'new',
  'in_progress',
  'converted',
  'declined',
] as const;

export type ReviewRequestState = (typeof REVIEW_REQUEST_STATES)[number];

export const REVIEW_REQUEST_PROJECTION =
  'id, employee_user_id, requested_by_user_id, project_id, problem, examples, desired_outcome, state, claimed_by, claimed_at, resolved_by, resolved_at, linked_review_id, decision_note, updated_by, created_at, updated_at';

const PROJECT_PROJECTION = 'id, client, name';

type JsonError = NextResponse<{ error: string; code?: string }>;
type AuthedClient = ReturnType<typeof createAuthedSupabaseClient>;
type ReviewRequestAccess = 'private' | 'submit';

export type ReviewRequestActor = {
  userId: string;
  authedClient: AuthedClient;
};

export type ReviewRequestAuthResult =
  | { actor: ReviewRequestActor }
  | { error: JsonError };

export type TeamReviewRequestRow = {
  id: string;
  employee_user_id: string;
  requested_by_user_id: string;
  project_id: string | null;
  problem: string;
  examples: string | null;
  desired_outcome: string;
  state: ReviewRequestState;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  linked_review_id: string | null;
  decision_note: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewRequestCreateInput = {
  employee_user_id: string;
  project_id: string | null;
  problem: string;
  examples: string | null;
  desired_outcome: string;
};

export type ReviewRequestActionInput = {
  action: 'claim' | 'decline';
  decision_note: string | null;
};

export type ReviewRequestConvertInput = {
  reviewDate: string;
  reviewReason: string | null;
  expectedUpdatedAt: string;
};

export type ReviewRequestProjectRow = {
  id: string;
  client: string | null;
  name: string | null;
};

export type ReviewRequestSupportData = {
  employees: ProfileRow[];
  profilesById: Map<string, ProfileRow>;
  projects: ReviewRequestProjectRow[];
  projectsById: Map<string, ReviewRequestProjectRow>;
};

export function jsonError(
  message: string,
  status: number,
  code?: string,
): JsonError {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status },
  );
}

export function logMeta(req: NextRequest, userId: string | null) {
  return {
    userId,
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    route: req.nextUrl.pathname,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };
}

export async function authenticateReviewRequestInbox(
  req: NextRequest,
  requiredAccess: ReviewRequestAccess,
): Promise<ReviewRequestAuthResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  let userId: string | null = null;
  try {
    const authedClient = createAuthedSupabaseClient(token);
    const authResult = await authedClient.auth.getUser();
    if (authResult.error) {
      if (authResult.error.status === 401 || authResult.error.status === 403) {
        return { error: jsonError('Unauthorized', 401) };
      }
      await logError(
        'team.review_requests.auth.failed',
        authResult.error,
        {},
        logMeta(req, userId),
      );
      return { error: jsonError('Failed to verify access', 500) };
    }
    const user = authResult.data.user;
    if (!user) return { error: jsonError('Unauthorized', 401) };
    userId = user.id;

    const access = requiredAccess === 'private'
      ? await checkTeamAccess(authedClient)
      : await checkTeamReviewRequestSubmitAccess(authedClient);

    if (access.error !== null) {
      await logError(
        'team.review_requests.auth.failed',
        access.error,
        { requiredAccess },
        logMeta(req, userId),
      );
      return { error: jsonError('Failed to verify access', 500) };
    }
    if (!access.allowed) return { error: jsonError('Forbidden', 403) };
    if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

    return { actor: { userId, authedClient } };
  } catch (error) {
    await logError(
      'team.review_requests.auth.failed',
      error,
      { requiredAccess },
      logMeta(req, userId),
    );
    return { error: jsonError('Failed to verify access', 500) };
  }
}

function parseRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string } | { error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    return { error: `${field} must contain between 1 and ${maxLength} characters` };
  }
  return { value: normalized };
}

function parseOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: `${field} must be a string or null` };
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters` };
  }
  return { value: normalized || null };
}

export function parseReviewRequestCreateInput(
  value: unknown,
): { value: ReviewRequestCreateInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid body' };
  }
  const body = value as Record<string, unknown>;

  const employee = pickInputValue(body, 'employeeUserId', 'employee_user_id');
  if (typeof employee.value !== 'string' || !isValidUuid(employee.value)) {
    return { error: 'employeeUserId must be a valid UUID' };
  }

  const project = pickInputValue(body, 'projectId', 'project_id');
  let projectId: string | null = null;
  if (project.present && project.value !== null && project.value !== undefined) {
    if (typeof project.value !== 'string' || !isValidUuid(project.value)) {
      return { error: 'projectId must be a valid UUID or null' };
    }
    projectId = project.value;
  }

  const problemField = pickInputValue(body, 'problem', 'problem');
  const problem = parseRequiredText(
    problemField.value,
    'problem',
    REVIEW_REQUEST_PROBLEM_MAX_LENGTH,
  );
  if ('error' in problem) return problem;

  const examplesField = pickInputValue(body, 'examples', 'examples');
  const examples = parseOptionalText(
    examplesField.value,
    'examples',
    REVIEW_REQUEST_EXAMPLES_MAX_LENGTH,
  );
  if ('error' in examples) return examples;

  const outcomeField = pickInputValue(body, 'desiredOutcome', 'desired_outcome');
  const desiredOutcome = parseRequiredText(
    outcomeField.value,
    'desiredOutcome',
    REVIEW_REQUEST_OUTCOME_MAX_LENGTH,
  );
  if ('error' in desiredOutcome) return desiredOutcome;

  return {
    value: {
      employee_user_id: employee.value,
      project_id: projectId,
      problem: problem.value,
      examples: examples.value,
      desired_outcome: desiredOutcome.value,
    },
  };
}

export function parseReviewRequestActionInput(
  value: unknown,
): { value: ReviewRequestActionInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid body' };
  }
  const body = value as Record<string, unknown>;
  if (body.action !== 'claim' && body.action !== 'decline') {
    return { error: 'action must be claim or decline' };
  }

  const decisionField = pickInputValue(body, 'decisionNote', 'decision_note');
  const decision = parseOptionalText(
    decisionField.value,
    'decisionNote',
    REVIEW_REQUEST_DECISION_MAX_LENGTH,
  );
  if ('error' in decision) return decision;

  return {
    value: {
      action: body.action,
      decision_note: body.action === 'decline' ? decision.value : null,
    },
  };
}

export function parseReviewRequestPrecondition(
  value: unknown,
): { value: UpdatePrecondition } | { error: 'missing' | 'invalid' } {
  return parseUpdatePrecondition(value);
}

export function parseReviewRequestConvertInput(
  value: unknown,
): { value: ReviewRequestConvertInput } | { error: string; status: 400 | 428 } {
  const precondition = parseReviewRequestPrecondition(value);
  if ('error' in precondition) {
    return precondition.error === 'missing'
      ? { error: 'expectedUpdatedAt is required', status: 428 }
      : { error: 'expectedUpdatedAt must be a valid RFC 3339 timestamp', status: 400 };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid body', status: 400 };
  }
  const body = value as Record<string, unknown>;
  const reviewDate = pickInputValue(body, 'reviewDate', 'review_date');
  if (typeof reviewDate.value !== 'string' || !isValidIsoDate(reviewDate.value)) {
    return { error: 'reviewDate must be a valid YYYY-MM-DD date', status: 400 };
  }

  const reviewReason = pickInputValue(body, 'reviewReason', 'review_reason');
  const parsedReason = parseOptionalText(
    reviewReason.value,
    'reviewReason',
    REVIEW_REQUEST_REASON_MAX_LENGTH,
  );
  if ('error' in parsedReason) return { error: parsedReason.error, status: 400 };

  return {
    value: {
      reviewDate: reviewDate.value,
      reviewReason: parsedReason.value,
      expectedUpdatedAt: precondition.value.expectedUpdatedAt,
    },
  };
}

export async function validateReviewRequestEmployee(
  employeeUserId: string,
): Promise<{ ok: true } | { error: JsonError }> {
  return validateInternalEmployee(employeeUserId);
}

export async function validateReviewRequestProject(
  projectId: string | null,
): Promise<{ ok: true } | { error: JsonError }> {
  if (projectId === null) return { ok: true };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();

  if (error) return { error: jsonError('Failed to validate project', 500) };
  if (!data) return { error: jsonError('projectId does not reference a project', 400) };
  return { ok: true };
}

export function projectToApi(project: ReviewRequestProjectRow) {
  return {
    id: project.id,
    name: formatTeamProjectLabel(project.client, project.name),
  };
}

export async function loadReviewRequestSupportData(): Promise<
  { value: ReviewRequestSupportData } | { error: JsonError }
> {
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const profileResult = await loadInternalProfiles();
  if ('error' in profileResult) return profileResult;

  let projects: ReviewRequestProjectRow[];
  try {
    projects = await collectPages(async (from, to) => {
      const page = await supabaseAdmin!
        .from('projects')
        .select(PROJECT_PROJECTION)
        .order('client', { ascending: true })
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      return {
        data: (page.data ?? []) as ReviewRequestProjectRow[],
        error: page.error ? { message: page.error.message } : null,
      };
    });
  } catch {
    return { error: jsonError('Failed to load projects', 500) };
  }

  return {
    value: {
      employees: profileResult.profiles,
      profilesById: new Map(
        profileResult.profiles.map((profile) => [profile.id, profile]),
      ),
      projects,
      projectsById: new Map(projects.map((project) => [project.id, project])),
    },
  };
}

export function reviewRequestToApi(
  request: TeamReviewRequestRow,
  support: Pick<ReviewRequestSupportData, 'profilesById' | 'projectsById'>,
) {
  const employee = support.profilesById.get(request.employee_user_id);
  const initiator = support.profilesById.get(request.requested_by_user_id);
  const claimedBy = request.claimed_by
    ? support.profilesById.get(request.claimed_by)
    : null;
  const resolvedBy = request.resolved_by
    ? support.profilesById.get(request.resolved_by)
    : null;
  const project = request.project_id
    ? support.projectsById.get(request.project_id)
    : null;

  return {
    id: request.id,
    state: request.state,
    employee: employee ? profileToApi(employee) : null,
    initiator: initiator ? profileToApi(initiator) : null,
    project: project ? projectToApi(project) : null,
    problem: request.problem,
    examples: request.examples ?? null,
    desiredOutcome: request.desired_outcome,
    claimedBy: claimedBy ? profileToApi(claimedBy) : null,
    claimedAt: request.claimed_at ?? null,
    resolvedBy: resolvedBy ? profileToApi(resolvedBy) : null,
    resolvedAt: request.resolved_at ?? null,
    linkedReviewId: request.linked_review_id ?? null,
    decisionNote: request.decision_note ?? null,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

export function reviewRequestSummary(rows: TeamReviewRequestRow[]) {
  const count = (state: ReviewRequestState) => rows.filter((row) => row.state === state).length;
  return {
    total: rows.length,
    newCount: count('new'),
    inProgressCount: count('in_progress'),
    convertedCount: count('converted'),
    declinedCount: count('declined'),
  };
}

export function reviewRequestGroups(
  rows: TeamReviewRequestRow[],
  support: Pick<ReviewRequestSupportData, 'profilesById' | 'projectsById'>,
) {
  return REVIEW_REQUEST_STATES.map((state) => ({
    state,
    requests: rows
      .filter((row) => row.state === state)
      .map((row) => reviewRequestToApi(row, support)),
  }));
}
