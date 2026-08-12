import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  isValidIsoDate,
  isValidUuid,
  parseUpdatePrecondition,
  pickInputValue,
  type UpdatePrecondition,
} from '@/lib/apiValidation';
import { currentMoscowDate } from '@/lib/calendarDate';
import { checkTeamAccess } from '@/lib/auth/teamAccess';
import { logError } from '@/lib/loggerServer';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const TALENT_RESERVE_PROJECTION =
  'id, contact, candidate_name, vacancy_direction, test_assignment, test_result, test_sent_on, interview_on, revisit_on, comment, revisit_note, stage, created_by, updated_by, created_at, updated_at';

export const TALENT_RESERVE_STAGES = [
  'new',
  'test',
  'interview',
  'reserve',
  'return_later',
  'hired',
  'rejected',
  'archived',
] as const;

const ACTIVE_STAGES = new Set<TalentReserveStage>([
  'new',
  'test',
  'interview',
  'reserve',
  'return_later',
]);

export const TALENT_RESERVE_TEXT_LIMITS = {
  contact: 500,
  candidateName: 200,
  vacancyDirection: 500,
  testAssignment: 5000,
  testResult: 500,
  comment: 5000,
  revisitNote: 500,
} as const;

export type TalentReserveStage = typeof TALENT_RESERVE_STAGES[number];

export type TalentReserveRow = {
  id: string;
  contact: string;
  candidate_name: string;
  vacancy_direction: string;
  test_assignment: string | null;
  test_result: string | null;
  test_sent_on: string | null;
  interview_on: string | null;
  revisit_on: string | null;
  comment: string | null;
  revisit_note: string | null;
  stage: TalentReserveStage;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TalentReserveInput = {
  contact?: string;
  candidate_name?: string;
  vacancy_direction?: string;
  test_assignment?: string | null;
  test_result?: string | null;
  test_sent_on?: string | null;
  interview_on?: string | null;
  revisit_on?: string | null;
  comment?: string | null;
  revisit_note?: string | null;
  stage?: TalentReserveStage;
};

type JsonError = NextResponse<{ error: string }>;

export type TalentReserveAuthResult =
  | { actor: { userId: string; canManage: true } }
  | { error: JsonError };

export function jsonError(message: string, status: number): JsonError {
  return NextResponse.json({ error: message }, { status });
}

export function logMeta(req: NextRequest, userId: string | null) {
  return {
    userId,
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    route: req.nextUrl.pathname,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };
}

export function databaseErrorForLog(operation: string): Error {
  const error = new Error(operation);
  error.name = 'TalentReserveDatabaseError';
  return error;
}

function isInvalidSessionAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export async function authenticateTalentReserveRequest(
  req: NextRequest,
): Promise<TalentReserveAuthResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  let userId: string | null = null;
  try {
    const authedClient = createAuthedSupabaseClient(token);
    const authResult = await (async () => {
      try {
        return await authedClient.auth.getUser();
      } catch (error) {
        if (isInvalidSessionAuthError(error)) return null;
        throw error;
      }
    })();
    if (authResult === null) {
      return { error: jsonError('Unauthorized', 401) };
    }
    if (authResult.error) {
      if (isInvalidSessionAuthError(authResult.error)) {
        return { error: jsonError('Unauthorized', 401) };
      }
      await logError(
        'team.talent_reserve.auth.failed',
        authResult.error,
        {},
        logMeta(req, userId),
      );
      return { error: jsonError('Failed to verify access', 500) };
    }
    const user = authResult.data.user;
    if (!user) return { error: jsonError('Unauthorized', 401) };
    userId = user.id;

    const access = await checkTeamAccess(authedClient);
    if (access.error !== null) {
      await logError(
        'team.talent_reserve.auth.failed',
        access.error,
        {},
        logMeta(req, userId),
      );
      return { error: jsonError('Failed to verify access', 500) };
    }
    if (!access.allowed) return { error: jsonError('Forbidden', 403) };

    return { actor: { userId, canManage: true } };
  } catch (error) {
    await logError(
      'team.talent_reserve.auth.failed',
      error,
      {},
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

function parseOptionalDate(
  value: unknown,
  field: string,
): { value: string | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    return { error: `${field} must be a valid YYYY-MM-DD date or null` };
  }
  return { value };
}

export function validateTalentReserveState(
  value: Pick<TalentReserveRow, 'stage' | 'revisit_on' | 'revisit_note'>,
): string | null {
  if (
    value.stage === 'return_later'
    && value.revisit_on === null
    && value.revisit_note === null
  ) {
    return 'return_later requires revisitOn or revisitNote';
  }
  return null;
}

export function validateTalentReservePatch(
  existing: TalentReserveRow,
  patch: TalentReserveInput,
): string | null {
  return validateTalentReserveState({
    stage: patch.stage ?? existing.stage,
    revisit_on: patch.revisit_on === undefined
      ? existing.revisit_on
      : patch.revisit_on,
    revisit_note: patch.revisit_note === undefined
      ? existing.revisit_note
      : patch.revisit_note,
  });
}

export function parseTalentReserveInput(
  value: unknown,
  options: { partial: boolean },
): { value: TalentReserveInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid body' };
  }

  const body = value as Record<string, unknown>;
  const result: TalentReserveInput = {};

  for (const [camelKey, snakeKey, maxLength] of [
    ['contact', 'contact', TALENT_RESERVE_TEXT_LIMITS.contact],
    ['candidateName', 'candidate_name', TALENT_RESERVE_TEXT_LIMITS.candidateName],
    ['vacancyDirection', 'vacancy_direction', TALENT_RESERVE_TEXT_LIMITS.vacancyDirection],
  ] as const) {
    const field = pickInputValue(body, camelKey, snakeKey);
    if (options.partial && !field.present) continue;
    const parsed = parseRequiredText(field.value, camelKey, maxLength);
    if ('error' in parsed) return parsed;
    result[snakeKey] = parsed.value;
  }

  for (const [camelKey, snakeKey, maxLength] of [
    ['testAssignment', 'test_assignment', TALENT_RESERVE_TEXT_LIMITS.testAssignment],
    ['testResult', 'test_result', TALENT_RESERVE_TEXT_LIMITS.testResult],
    ['comment', 'comment', TALENT_RESERVE_TEXT_LIMITS.comment],
    ['revisitNote', 'revisit_note', TALENT_RESERVE_TEXT_LIMITS.revisitNote],
  ] as const) {
    const field = pickInputValue(body, camelKey, snakeKey);
    if (options.partial && !field.present) continue;
    const parsed = parseOptionalText(field.value, camelKey, maxLength);
    if ('error' in parsed) return parsed;
    result[snakeKey] = parsed.value;
  }

  for (const [camelKey, snakeKey] of [
    ['testSentOn', 'test_sent_on'],
    ['interviewOn', 'interview_on'],
    ['revisitOn', 'revisit_on'],
  ] as const) {
    const field = pickInputValue(body, camelKey, snakeKey);
    if (options.partial && !field.present) continue;
    const parsed = parseOptionalDate(field.value, camelKey);
    if ('error' in parsed) return parsed;
    result[snakeKey] = parsed.value;
  }

  const stage = pickInputValue(body, 'stage', 'stage');
  if (!options.partial || stage.present) {
    const stageValue = stage.present ? stage.value : 'new';
    if (
      typeof stageValue !== 'string'
      || !TALENT_RESERVE_STAGES.includes(stageValue as TalentReserveStage)
    ) {
      return { error: `stage must be one of ${TALENT_RESERVE_STAGES.join(', ')}` };
    }
    result.stage = stageValue as TalentReserveStage;
  }

  if (options.partial && Object.keys(result).length === 0) {
    return { error: 'At least one talent reserve field is required' };
  }

  if (!options.partial) {
    const stateError = validateTalentReserveState({
      stage: result.stage!,
      revisit_on: result.revisit_on ?? null,
      revisit_note: result.revisit_note ?? null,
    });
    if (stateError) return { error: stateError };
  }

  return { value: result };
}

export function parseTalentReservePrecondition(
  value: unknown,
): { value: UpdatePrecondition } | { error: 'missing' | 'invalid' } {
  return parseUpdatePrecondition(value);
}

export function talentReserveEntryToApi(row: TalentReserveRow) {
  return {
    id: row.id,
    contact: row.contact,
    candidateName: row.candidate_name,
    vacancyDirection: row.vacancy_direction,
    testAssignment: row.test_assignment ?? null,
    testResult: row.test_result ?? null,
    testSentOn: row.test_sent_on ?? null,
    interviewOn: row.interview_on ?? null,
    revisitOn: row.revisit_on ?? null,
    comment: row.comment ?? null,
    revisitNote: row.revisit_note ?? null,
    stage: row.stage,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attentionDate(row: TalentReserveRow, asOf: string): string | null {
  if (row.stage === 'interview' && row.interview_on !== null) {
    return row.interview_on <= asOf ? row.interview_on : null;
  }
  if (row.stage === 'return_later' && row.revisit_on !== null) {
    return row.revisit_on <= asOf ? row.revisit_on : null;
  }
  return null;
}

function compareDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

export function sortTalentReserveRows(
  rows: TalentReserveRow[],
  asOf: string,
): TalentReserveRow[] {
  return [...rows].sort((left, right) => {
    const leftAttention = attentionDate(left, asOf);
    const rightAttention = attentionDate(right, asOf);
    const leftGroup = leftAttention !== null ? 0 : ACTIVE_STAGES.has(left.stage) ? 1 : 2;
    const rightGroup = rightAttention !== null ? 0 : ACTIVE_STAGES.has(right.stage) ? 1 : 2;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    if (leftGroup === 0 && leftAttention !== rightAttention) {
      return String(leftAttention).localeCompare(String(rightAttention));
    }
    return compareDescending(left.updated_at, right.updated_at)
      || left.id.localeCompare(right.id);
  });
}

export function talentReserveSummary(rows: TalentReserveRow[], asOf: string) {
  const activeCount = rows.filter((row) => ACTIVE_STAGES.has(row.stage)).length;
  return {
    total: rows.length,
    attentionCount: rows.filter((row) => attentionDate(row, asOf) !== null).length,
    activeCount,
    historyCount: rows.length - activeCount,
  };
}

export { currentMoscowDate, isValidUuid };
