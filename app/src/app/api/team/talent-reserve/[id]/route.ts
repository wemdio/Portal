import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  TALENT_RESERVE_PROJECTION,
  authenticateTalentReserveRequest,
  databaseErrorForLog,
  isValidUuid,
  jsonError,
  logMeta,
  parseTalentReserveInput,
  parseTalentReservePrecondition,
  talentReserveEntryToApi,
  validateTalentReservePatch,
  type TalentReserveRow,
} from '../helpers';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

type ConflictCode =
  | 'invalid_precondition'
  | 'precondition_required'
  | 'talent_reserve_conflict';

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
    'Talent reserve entry was changed by another user. Reload it and try again.',
    409,
    'talent_reserve_conflict',
    { currentUpdatedAt },
  );
}

function parsePreconditionOrResponse(body: unknown) {
  const parsed = parseTalentReservePrecondition(body);
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
  entryId: string,
) {
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { data, error } = await supabaseAdmin
    .from('team_talent_reserve_entries')
    .select('id, updated_at')
    .eq('id', entryId)
    .maybeSingle();

  if (error) {
    await logError(
      'team.talent_reserve.conflict_reload.failed',
      databaseErrorForLog('Talent reserve conflict reload query failed'),
      { entryId },
      logMeta(req, actorUserId),
    );
    return jsonError('Failed to verify talent reserve change', 500);
  }
  if (!data) return jsonError('Talent reserve entry not found', 404);
  return conflict(String(data.updated_at));
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await authenticateTalentReserveRequest(req);
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

  const parsed = parseTalentReserveInput(body, { partial: true });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const { id } = await context.params;
  if (!isValidUuid(id)) return jsonError('Invalid talent reserve entry id', 400);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('team_talent_reserve_entries')
    .select(TALENT_RESERVE_PROJECTION)
    .eq('id', id)
    .maybeSingle();

  if (existingError) {
    await logError(
      'team.talent_reserve.update.read.failed',
      databaseErrorForLog('Talent reserve update read query failed'),
      { entryId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load talent reserve entry', 500);
  }
  if (!existing) return jsonError('Talent reserve entry not found', 404);

  const expectedUpdatedAt = precondition.value.expectedUpdatedAt;
  if (existing.updated_at !== expectedUpdatedAt) {
    return conflict(String(existing.updated_at));
  }

  const stateError = validateTalentReservePatch(
    existing as TalentReserveRow,
    parsed.value,
  );
  if (stateError) return jsonError(stateError, 400);

  const update = {
    ...parsed.value,
    updated_by: actor.userId,
  };
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('team_talent_reserve_entries')
    .update(update)
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select(TALENT_RESERVE_PROJECTION)
    .maybeSingle();

  if (updateError) {
    await logError(
      'team.talent_reserve.update.failed',
      databaseErrorForLog('Talent reserve update query failed'),
      { entryId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to update talent reserve entry', 500);
  }
  if (!updated) {
    return reloadConflictTarget(req, actor.userId, id);
  }

  await logAudit(
    'team.talent_reserve.update.success',
    'Talent reserve entry updated',
    { entryId: id, changedFields: Object.keys(parsed.value) },
    logMeta(req, actor.userId),
  );

  return NextResponse.json({
    entry: talentReserveEntryToApi(updated as TalentReserveRow),
  });
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const auth = await authenticateTalentReserveRequest(req);
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
  if (!isValidUuid(id)) return jsonError('Invalid talent reserve entry id', 400);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('team_talent_reserve_entries')
    .select('id, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (existingError) {
    await logError(
      'team.talent_reserve.delete.read.failed',
      databaseErrorForLog('Talent reserve delete read query failed'),
      { entryId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load talent reserve entry', 500);
  }
  if (!existing) return jsonError('Talent reserve entry not found', 404);

  const expectedUpdatedAt = precondition.value.expectedUpdatedAt;
  if (existing.updated_at !== expectedUpdatedAt) {
    return conflict(String(existing.updated_at));
  }

  const { data: deletedMatch, error: deleteError } = await supabaseAdmin
    .from('team_talent_reserve_entries')
    .delete()
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id')
    .maybeSingle();

  if (deleteError) {
    await logError(
      'team.talent_reserve.delete.failed',
      databaseErrorForLog('Talent reserve delete query failed'),
      { entryId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to delete talent reserve entry', 500);
  }
  if (!deletedMatch) {
    return reloadConflictTarget(req, actor.userId, id);
  }

  await logAudit(
    'team.talent_reserve.delete.success',
    'Talent reserve entry deleted',
    { entryId: id },
    logMeta(req, actor.userId),
  );

  return new NextResponse(null, { status: 204 });
}
