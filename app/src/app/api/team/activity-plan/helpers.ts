import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  isValidIsoDate,
  parseUpdatePrecondition,
  pickInputValue,
  type UpdatePrecondition,
} from '@/lib/apiValidation';
import { logError } from '@/lib/loggerServer';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const PERIODICITY_MAX_LENGTH = 100;
export const ACTIVITY_MAX_LENGTH = 500;
export const SHORT_TEXT_MAX_LENGTH = 500;
export const NOTE_MAX_LENGTH = 5000;
export const MAX_BUDGET_AMOUNT = 9_999_999_999.99;
export const MAX_POSITION = 2_147_483_647;

export const ACTIVITY_PLAN_PROJECTION =
  'id, plan_month, periodicity, activity, format, planned_date, planned_time, schedule_note, note, budget_amount, budget_note, status, position, created_by, created_at, updated_at';

export type ActivityPlanStatus = 'planned' | 'completed' | 'cancelled';

export type ActivityPlanRow = {
  id: string;
  plan_month: string;
  periodicity: string;
  activity: string;
  format: string | null;
  planned_date: string | null;
  planned_time: string | null;
  schedule_note: string | null;
  note: string | null;
  budget_amount: number | string | null;
  budget_note: string | null;
  status: ActivityPlanStatus;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivityPlanInput = {
  plan_month?: string;
  periodicity?: string;
  activity?: string;
  format?: string | null;
  planned_date?: string | null;
  planned_time?: string | null;
  schedule_note?: string | null;
  note?: string | null;
  budget_amount?: number | null;
  budget_note?: string | null;
  status?: ActivityPlanStatus;
  position?: number;
};

type JsonError = NextResponse<{ error: string }>;

export type ActivityPlanAuthResult =
  | { actor: { userId: string; canManage: boolean } }
  | { error: JsonError };

type ActivityPlanAccess = 'view' | 'manage';

const ACTIVITY_PLAN_CAPABILITY_FUNCTION = {
  view: 'can_view_team_activity_plan',
  manage: 'can_manage_team_activity_plan',
} as const;

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

export async function authenticateActivityPlanRequest(
  req: NextRequest,
  requiredAccess: ActivityPlanAccess = 'manage',
): Promise<ActivityPlanAuthResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  let userId: string | null = null;
  try {
    const authedClient = createAuthedSupabaseClient(token);
    const authResult = await authedClient.auth.getUser();
    const user = authResult.data.user;
    if (!user) return { error: jsonError('Unauthorized', 401) };
    userId = user.id;

    const checkCapability = async (
      access: ActivityPlanAccess,
    ): Promise<{ allowed: boolean } | { error: JsonError }> => {
      const { data, error } = await authedClient.rpc(
        ACTIVITY_PLAN_CAPABILITY_FUNCTION[access],
      );
      if (!error) return { allowed: data === true };

      await logError(
        'team.activity_plan.auth.failed',
        error,
        {},
        logMeta(req, userId),
      );
      return { error: jsonError('Failed to verify access', 500) };
    };

    const required = await checkCapability(requiredAccess);
    if ('error' in required) return required;
    if (!required.allowed) return { error: jsonError('Forbidden', 403) };

    if (requiredAccess === 'manage') {
      return { actor: { userId, canManage: true } };
    }

    const management = await checkCapability('manage');
    if ('error' in management) return management;

    return { actor: { userId, canManage: management.allowed } };
  } catch (error) {
    await logError(
      'team.activity_plan.auth.failed',
      error,
      {},
      logMeta(req, userId),
    );
    return { error: jsonError('Failed to verify access', 500) };
  }
}

export { isValidUuid } from '@/lib/apiValidation';
export { currentMoscowDate } from '@/lib/calendarDate';

export function isValidPlanMonth(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return year >= 1000 && year <= 9999 && month >= 1 && month <= 12;
}

export function planMonthToDatabase(value: string): string {
  return `${value}-01`;
}

type ActivityPlanTiming = {
  planned_date: string | null;
  planned_time: string | null;
  schedule_note: string | null;
};

export function validateActivityPlanTiming(value: ActivityPlanTiming): string | null {
  if (value.planned_time !== null && value.planned_date === null) {
    return 'plannedTime requires plannedDate';
  }
  if (value.planned_date !== null && value.schedule_note !== null) {
    return 'plannedDate and scheduleNote cannot be used together';
  }
  return null;
}

export function validateActivityPlanPatchTiming(
  existing: ActivityPlanRow,
  patch: ActivityPlanInput,
): string | null {
  return validateActivityPlanTiming({
    planned_date: patch.planned_date === undefined
      ? existing.planned_date
      : patch.planned_date,
    planned_time: patch.planned_time === undefined
      ? existing.planned_time
      : patch.planned_time,
    schedule_note: patch.schedule_note === undefined
      ? existing.schedule_note
      : patch.schedule_note,
  });
}

function parseRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string } | { error: string } {
  if (typeof value !== 'string') {
    return { error: `${field} must be a string` };
  }
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
  if (typeof value !== 'string') {
    return { error: `${field} must be a string or null` };
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters` };
  }
  return { value: normalized || null };
}

function parseOptionalDate(
  value: unknown,
): { value: string | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    return { error: 'plannedDate must be a valid YYYY-MM-DD date or null' };
  }
  return { value };
}

function parseOptionalTime(
  value: unknown,
): { value: string | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    return { error: 'plannedTime must use HH:mm or be null' };
  }
  const [hour, minute] = value.split(':').map(Number);
  if (hour > 23 || minute > 59) {
    return { error: 'plannedTime must use HH:mm or be null' };
  }
  return { value };
}

function parseBudgetAmount(
  value: unknown,
): { value: number | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: 'budgetAmount must be a number or null' };
  }
  const cents = Math.round(value * 100);
  if (
    value < 0
    || value > MAX_BUDGET_AMOUNT
    || Math.abs((value * 100) - cents) > 1e-8
  ) {
    return { error: 'budgetAmount must be a non-negative amount with at most 2 decimal places' };
  }
  return { value: cents / 100 };
}

function parsePosition(value: unknown): { value: number } | { error: string } {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > MAX_POSITION
  ) {
    return { error: 'position must be a non-negative integer' };
  }
  return { value };
}

export function parseActivityPlanInput(
  value: unknown,
  options: { partial: boolean },
): { value: ActivityPlanInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid body' };
  }

  const body = value as Record<string, unknown>;
  const result: ActivityPlanInput = {};

  const planMonth = pickInputValue(body, 'planMonth', 'plan_month');
  if (!options.partial || planMonth.present) {
    if (typeof planMonth.value !== 'string' || !isValidPlanMonth(planMonth.value)) {
      return { error: 'planMonth must be a valid YYYY-MM month' };
    }
    result.plan_month = planMonthToDatabase(planMonth.value);
  }

  for (const [camelKey, snakeKey, maxLength] of [
    ['periodicity', 'periodicity', PERIODICITY_MAX_LENGTH],
    ['activity', 'activity', ACTIVITY_MAX_LENGTH],
  ] as const) {
    const field = pickInputValue(body, camelKey, snakeKey);
    if (options.partial && !field.present) continue;
    const parsed = parseRequiredText(field.value, camelKey, maxLength);
    if ('error' in parsed) return parsed;
    result[snakeKey] = parsed.value;
  }

  for (const [camelKey, snakeKey, maxLength] of [
    ['format', 'format', SHORT_TEXT_MAX_LENGTH],
    ['scheduleNote', 'schedule_note', SHORT_TEXT_MAX_LENGTH],
    ['note', 'note', NOTE_MAX_LENGTH],
    ['budgetNote', 'budget_note', SHORT_TEXT_MAX_LENGTH],
  ] as const) {
    const field = pickInputValue(body, camelKey, snakeKey);
    if (options.partial && !field.present) continue;
    const parsed = parseOptionalText(field.value, camelKey, maxLength);
    if ('error' in parsed) return parsed;
    result[snakeKey] = parsed.value;
  }

  const plannedDate = pickInputValue(body, 'plannedDate', 'planned_date');
  if (!options.partial || plannedDate.present) {
    const parsed = parseOptionalDate(plannedDate.value);
    if ('error' in parsed) return parsed;
    result.planned_date = parsed.value;
  }

  const plannedTime = pickInputValue(body, 'plannedTime', 'planned_time');
  if (!options.partial || plannedTime.present) {
    const parsed = parseOptionalTime(plannedTime.value);
    if ('error' in parsed) return parsed;
    result.planned_time = parsed.value;
  }

  const budgetAmount = pickInputValue(body, 'budgetAmount', 'budget_amount');
  if (!options.partial || budgetAmount.present) {
    const parsed = parseBudgetAmount(budgetAmount.value);
    if ('error' in parsed) return parsed;
    result.budget_amount = parsed.value;
  }

  const status = pickInputValue(body, 'status', 'status');
  if (!options.partial || status.present) {
    const statusValue = status.present ? status.value : 'planned';
    if (
      statusValue !== 'planned'
      && statusValue !== 'completed'
      && statusValue !== 'cancelled'
    ) {
      return { error: 'status must be planned, completed or cancelled' };
    }
    result.status = statusValue;
  }

  const position = pickInputValue(body, 'position', 'position');
  if (!options.partial || position.present) {
    const parsed = parsePosition(position.present ? position.value : 0);
    if ('error' in parsed) return parsed;
    result.position = parsed.value;
  }

  if (options.partial && Object.keys(result).length === 0) {
    return { error: 'At least one activity plan field is required' };
  }

  if (!options.partial) {
    const timingError = validateActivityPlanTiming({
      planned_date: result.planned_date ?? null,
      planned_time: result.planned_time ?? null,
      schedule_note: result.schedule_note ?? null,
    });
    if (timingError) return { error: timingError };
  }

  return { value: result };
}

export function parseActivityPlanPrecondition(
  value: unknown,
): { value: UpdatePrecondition } | { error: 'missing' | 'invalid' } {
  return parseUpdatePrecondition(value);
}

function normalizeDatabaseTime(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : value;
}

function normalizeBudgetAmount(value: number | string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function activityPlanItemToApi(row: ActivityPlanRow) {
  return {
    id: row.id,
    planMonth: row.plan_month.slice(0, 7),
    periodicity: row.periodicity,
    activity: row.activity,
    format: row.format ?? null,
    plannedDate: row.planned_date ?? null,
    plannedTime: normalizeDatabaseTime(row.planned_time),
    scheduleNote: row.schedule_note ?? null,
    note: row.note ?? null,
    budgetAmount: normalizeBudgetAmount(row.budget_amount),
    budgetNote: row.budget_note ?? null,
    status: row.status,
    position: row.position,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function shiftPlanMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const minIndex = 1000 * 12;
  const maxIndex = (9999 * 12) + 11;
  const monthIndex = Math.min(
    maxIndex,
    Math.max(minIndex, (year * 12) + monthNumber - 1 + offset),
  );
  const shiftedYear = Math.floor(monthIndex / 12);
  const shiftedMonth = (monthIndex % 12) + 1;
  return `${shiftedYear}-${String(shiftedMonth).padStart(2, '0')}`;
}

export function activityPlanPeriod(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const rawLabel = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  const normalizedLabel = rawLabel.replace(/\s*г\.$/u, '');
  const label = normalizedLabel.charAt(0).toLocaleUpperCase('ru-RU') + normalizedLabel.slice(1);

  return {
    month,
    label,
    previousMonth: shiftPlanMonth(month, -1),
    nextMonth: shiftPlanMonth(month, 1),
  };
}

export function activityPlanSummary(rows: ActivityPlanRow[], asOf: string) {
  const budgetAmount = rows.reduce(
    (sum, row) => sum + (normalizeBudgetAmount(row.budget_amount) ?? 0),
    0,
  );

  return {
    total: rows.length,
    planned: rows.filter((row) => row.status === 'planned').length,
    completed: rows.filter((row) => row.status === 'completed').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    overdue: rows.filter(
      (row) => row.status === 'planned'
        && row.planned_date !== null
        && row.planned_date < asOf,
    ).length,
    budgetAmount: Math.round(budgetAmount * 100) / 100,
    budgetUnspecified: rows.filter((row) => row.budget_amount === null).length,
  };
}
