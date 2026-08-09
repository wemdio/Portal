import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  ACTIVITY_PLAN_PROJECTION,
  activityPlanItemToApi,
  authenticateActivityPlanRequest,
  isValidUuid,
  jsonError,
  logMeta,
  parseActivityPlanInput,
  parseActivityPlanPrecondition,
  validateActivityPlanPatchTiming,
  type ActivityPlanRow,
} from '../helpers';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

type ConflictCode =
  | 'invalid_precondition'
  | 'precondition_required'
  | 'activity_plan_conflict';

function preconditionError(
  message: string,
  status: 400 | 409 | 428,
  code: ConflictCode,
  details: Record<string, unknown> = {},
) {
  return NextResponse.json({ error: message, code, ...details }, { status });
}

function conflict(currentUpdatedAt: string) {
  return preconditionError(
    'Activity plan item was changed by another user. Reload it and try again.',
    409,
    'activity_plan_conflict',
    { currentUpdatedAt },
  );
}

function parsePreconditionOrResponse(body: unknown) {
  const parsed = parseActivityPlanPrecondition(body);
  if (!('error' in parsed)) return parsed;
  return {
    response: parsed.error === 'missing'
      ? preconditionError(
          'expectedUpdatedAt is required',
          428,
          'precondition_required',
        )
      : preconditionError(
          'expectedUpdatedAt must be a valid RFC 3339 timestamp',
          400,
          'invalid_precondition',
        ),
  };
}

async function reloadConflictTarget(
  req: NextRequest,
  actorUserId: string,
  itemId: string,
) {
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { data, error } = await supabaseAdmin
    .from('team_activity_plan_items')
    .select('id, updated_at')
    .eq('id', itemId)
    .maybeSingle();

  if (error) {
    await logError(
      'team.activity_plan.conflict_reload.failed',
      error,
      { itemId },
      logMeta(req, actorUserId),
    );
    return jsonError('Failed to verify activity plan change', 500);
  }
  if (!data) return jsonError('Activity plan item not found', 404);
  return conflict(String(data.updated_at));
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await authenticateActivityPlanRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const precondition = parsePreconditionOrResponse(body);
  if ('response' in precondition) return precondition.response;

  const parsed = parseActivityPlanInput(body, { partial: true });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const { id } = await context.params;
  if (!isValidUuid(id)) return jsonError('Invalid activity plan item id', 400);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('team_activity_plan_items')
    .select(ACTIVITY_PLAN_PROJECTION)
    .eq('id', id)
    .maybeSingle();

  if (existingError) {
    await logError(
      'team.activity_plan.update.read.failed',
      existingError,
      { itemId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load activity plan item', 500);
  }
  if (!existing) return jsonError('Activity plan item not found', 404);

  const expectedUpdatedAt = precondition.value.expectedUpdatedAt;
  if (existing.updated_at !== expectedUpdatedAt) {
    return conflict(String(existing.updated_at));
  }

  const timingError = validateActivityPlanPatchTiming(
    existing as ActivityPlanRow,
    parsed.value,
  );
  if (timingError) return jsonError(timingError, 400);

  const { data: updatedMatch, error: updateError } = await supabaseAdmin
    .from('team_activity_plan_items')
    .update(parsed.value)
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id')
    .maybeSingle();

  if (updateError) {
    await logError(
      'team.activity_plan.update.failed',
      updateError,
      { itemId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to update activity plan item', 500);
  }
  if (!updatedMatch) {
    return reloadConflictTarget(req, actor.userId, id);
  }

  const { data: updated, error: updatedError } = await supabaseAdmin
    .from('team_activity_plan_items')
    .select(ACTIVITY_PLAN_PROJECTION)
    .eq('id', id)
    .single();

  if (updatedError || !updated) {
    await logError(
      'team.activity_plan.update.reload.failed',
      updatedError ?? new Error('Activity plan update returned no row'),
      { itemId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load updated activity plan item', 500);
  }

  await logAudit(
    'team.activity_plan.update.success',
    'Team activity plan item updated',
    { itemId: id, changedFields: Object.keys(parsed.value) },
    logMeta(req, actor.userId),
  );

  return NextResponse.json({
    item: activityPlanItemToApi(updated as ActivityPlanRow),
  });
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const auth = await authenticateActivityPlanRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const precondition = parsePreconditionOrResponse(body);
  if ('response' in precondition) return precondition.response;

  const { id } = await context.params;
  if (!isValidUuid(id)) return jsonError('Invalid activity plan item id', 400);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('team_activity_plan_items')
    .select('id, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (existingError) {
    await logError(
      'team.activity_plan.delete.read.failed',
      existingError,
      { itemId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load activity plan item', 500);
  }
  if (!existing) return jsonError('Activity plan item not found', 404);

  const expectedUpdatedAt = precondition.value.expectedUpdatedAt;
  if (existing.updated_at !== expectedUpdatedAt) {
    return conflict(String(existing.updated_at));
  }

  const { data: deletedMatch, error: deleteError } = await supabaseAdmin
    .from('team_activity_plan_items')
    .delete()
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id')
    .maybeSingle();

  if (deleteError) {
    await logError(
      'team.activity_plan.delete.failed',
      deleteError,
      { itemId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to delete activity plan item', 500);
  }
  if (!deletedMatch) {
    return reloadConflictTarget(req, actor.userId, id);
  }

  await logAudit(
    'team.activity_plan.delete.success',
    'Team activity plan item deleted',
    { itemId: id },
    logMeta(req, actor.userId),
  );

  return new NextResponse(null, { status: 204 });
}
