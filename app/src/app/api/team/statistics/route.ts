import { NextRequest, NextResponse } from 'next/server';
import { isLeadershipUser } from '@/lib/auth/internalGuard';
import { collectPages } from '@/lib/collectPages';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import {
  TeamStatisticsInputError,
  buildTeamStatistics,
  emptyTeamStatisticsData,
  getStatisticsCoverage,
  resolveReportingPeriod,
  teamStatisticsBusinessDate,
  type TeamKpiHistoryRow,
  type TeamProjectHistoryRow,
  type TeamStatisticsProfile,
  type TeamStatisticsResponse,
} from '@/lib/teamStatistics';

export const dynamic = 'force-dynamic';

const HISTORY_COLUMNS = [
  'id',
  'project_id',
  'period_id',
  'project_name',
  'client',
  'project_status',
  'period_status',
  'manager',
  'specialist',
  'specialist_user_id',
  'kpi_plan',
  'kpi_fact',
  'launch_date',
  'deadline',
  'period_start',
  'period_end',
  'capture_source',
  'captured_at',
].join(', ');

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}


export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const authed = createAuthedSupabaseClient(token);
  const { data: authData, error: authError } = await authed.auth.getUser();
  if (authError || !authData?.user) return jsonError('Unauthorized', 401);
  if (!(await isLeadershipUser(authed, authData.user.id))) return jsonError('Forbidden', 403);

  const params = new URL(req.url).searchParams;
  let period;
  try {
    period = resolveReportingPeriod(params.get('period'), params.get('anchor'));
  } catch (error) {
    if (error instanceof TeamStatisticsInputError) return jsonError(error.message, 400);
    throw error;
  }

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const admin = supabaseAdmin;

  const { data: firstSnapshot, error: firstSnapshotError } = await admin
    .from('team_project_history')
    .select('captured_at')
    .order('captured_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (firstSnapshotError) return jsonError(firstSnapshotError.message, 500);

  const firstCapturedAt = typeof firstSnapshot?.captured_at === 'string'
    ? firstSnapshot.captured_at
    : null;
  const coverageStartsAt = firstCapturedAt
    ? teamStatisticsBusinessDate(firstCapturedAt)
    : null;
  if (firstCapturedAt && !coverageStartsAt) return jsonError('Invalid history timestamp', 500);

  const coverage = getStatisticsCoverage(period.start, period.end, coverageStartsAt);
  if (coverage.status === 'unavailable') {
    const body: TeamStatisticsResponse = {
      period,
      coverage,
      ...emptyTeamStatisticsData(),
    };
    return NextResponse.json(body);
  }

  let historyData: TeamProjectHistoryRow[];
  try {
    historyData = await collectPages(async (from, to) => {
      const page = await admin
        .from('team_project_history')
        .select(HISTORY_COLUMNS)
        .order('captured_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      return {
        data: (page.data ?? []) as unknown as TeamProjectHistoryRow[],
        error: page.error ? { message: page.error.message } : null,
      };
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Failed to load history', 500);
  }

  const { data: profileData, error: profileError } = await admin
    .from('profiles')
    .select('id, email, full_name');
  if (profileError) return jsonError(profileError.message, 500);

  let kpiHistory: TeamKpiHistoryRow[] = [];
  if (coverage.status === 'partial') {
    try {
      kpiHistory = await collectPages(async (from, to) => {
        const page = await admin
          .from('project_contacts_history')
          .select('project_id, period_id, kpi_fact, recorded_at')
          .lte('recorded_at', period.end)
          .order('recorded_at', { ascending: true })
          .order('project_id', { ascending: true })
          .order('period_id', { ascending: true, nullsFirst: true })
          .order('id', { ascending: true })
          .range(from, to);
        return {
          data: (page.data ?? []) as unknown as TeamKpiHistoryRow[],
          error: page.error ? { message: page.error.message } : null,
        };
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : 'Failed to load KPI history', 500);
    }
  }

  const statistics = buildTeamStatistics({
    range: period,
    history: historyData,
    profiles: (profileData ?? []) as TeamStatisticsProfile[],
    kpiHistory,
  });

  const body: TeamStatisticsResponse = {
    period,
    coverage,
    ...statistics,
  };
  return NextResponse.json(body);
}
