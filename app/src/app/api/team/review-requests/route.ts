import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { collectPages } from '@/lib/collectPages';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequestInbox,
  jsonError,
  loadReviewRequestSupportData,
  logMeta,
  parseReviewRequestCreateInput,
  projectToApi,
  REVIEW_REQUEST_PROJECTION,
  reviewRequestGroups,
  reviewRequestSummary,
  validateReviewRequestEmployee,
  validateReviewRequestProject,
  type TeamReviewRequestRow,
} from './helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateReviewRequestInbox(req, 'private');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { actor } = auth;

  let requests: TeamReviewRequestRow[];
  try {
    requests = await collectPages(async (from, to) => {
      const page = await supabaseAdmin!
        .from('team_review_requests')
        .select(REVIEW_REQUEST_PROJECTION)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to);
      return {
        data: (page.data ?? []) as TeamReviewRequestRow[],
        error: page.error ? { message: page.error.message } : null,
      };
    });
  } catch (error) {
    await logError(
      'team.review_requests.list.failed',
      error,
      {},
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load review requests', 500);
  }

  const support = await loadReviewRequestSupportData();
  if ('error' in support) return support.error;

  return NextResponse.json({
    groups: reviewRequestGroups(requests, support.value),
    summary: reviewRequestSummary(requests),
    employees: support.value.employees.map((profile) => ({
      id: profile.id,
      name: profile.full_name?.trim() || profile.email || 'Сотрудник',
      email: profile.email,
      avatarUrl: profile.avatar_url,
    })),
    projects: support.value.projects.map(projectToApi),
    canManage: true,
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateReviewRequestInbox(req, 'submit');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { actor } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const parsed = parseReviewRequestCreateInput(body);
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const employee = await validateReviewRequestEmployee(
    parsed.value.employee_user_id,
  );
  if ('error' in employee) return employee.error;

  const project = await validateReviewRequestProject(parsed.value.project_id);
  if ('error' in project) return project.error;

  const row = {
    ...parsed.value,
    requested_by_user_id: actor.userId,
    state: 'new' as const,
    updated_by: actor.userId,
  };
  const { data, error } = await supabaseAdmin
    .from('team_review_requests')
    .insert(row)
    .select('id')
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      return jsonError(
        'An unresolved review request already exists for this employee',
        409,
        'review_request_conflict',
      );
    }
    await logError(
      'team.review_requests.create.failed',
      error ?? new Error('Review request insert returned no row'),
      {
        employeeUserId: parsed.value.employee_user_id,
        projectId: parsed.value.project_id,
      },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to create review request', 500);
  }

  const requestId = String(data.id);
  await logAudit(
    'team.review_requests.create.success',
    'Team review request created',
    {
      requestId,
      employeeUserId: parsed.value.employee_user_id,
      projectId: parsed.value.project_id,
    },
    logMeta(req, actor.userId),
  );

  return NextResponse.json({ requestId }, { status: 201 });
}
