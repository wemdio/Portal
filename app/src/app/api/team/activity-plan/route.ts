import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  ACTIVITY_PLAN_PROJECTION,
  activityPlanItemToApi,
  activityPlanPeriod,
  activityPlanSummary,
  authenticateActivityPlanRequest,
  currentMoscowDate,
  isValidPlanMonth,
  jsonError,
  logMeta,
  parseActivityPlanInput,
  planMonthToDatabase,
  sortActivityPlanRowsByDeadline,
  type ActivityPlanRow,
} from './helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateActivityPlanRequest(req, 'view');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;
  const month = req.nextUrl.searchParams.get('month');
  if (!month || !isValidPlanMonth(month)) {
    return jsonError('month must be a valid YYYY-MM month', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('team_activity_plan_items')
    .select(ACTIVITY_PLAN_PROJECTION)
    .eq('plan_month', planMonthToDatabase(month))
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    await logError(
      'team.activity_plan.list.failed',
      error,
      { planMonth: month },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load activity plan', 500);
  }

  const rows = sortActivityPlanRowsByDeadline((data ?? []) as ActivityPlanRow[]);
  const asOf = currentMoscowDate();
  return NextResponse.json({
    asOf,
    period: activityPlanPeriod(month),
    items: rows.map(activityPlanItemToApi),
    summary: activityPlanSummary(rows, asOf),
    canManage: actor.canManage,
  });
}

export async function POST(req: NextRequest) {
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

  const parsed = parseActivityPlanInput(body, { partial: false });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const row = {
    ...parsed.value,
    created_by: actor.userId,
  };
  const { data, error } = await supabaseAdmin
    .from('team_activity_plan_items')
    .insert(row)
    .select(ACTIVITY_PLAN_PROJECTION)
    .single();

  const planMonth = parsed.value.plan_month!.slice(0, 7);
  if (error || !data) {
    await logError(
      'team.activity_plan.create.failed',
      error ?? new Error('Activity plan insert returned no row'),
      { planMonth },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to create activity plan item', 500);
  }

  await logAudit(
    'team.activity_plan.create.success',
    'Team activity plan item created',
    { itemId: String(data.id), planMonth },
    logMeta(req, actor.userId),
  );

  return NextResponse.json(
    { item: activityPlanItemToApi(data as ActivityPlanRow) },
    { status: 201 },
  );
}
