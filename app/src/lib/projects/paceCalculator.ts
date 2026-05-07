/**
 * Pace / velocity calculation for the "Projects" page tooltips.
 *
 * Two responsibilities live here:
 *   1) `computePace` — pure function turning a series of cumulative snapshots
 *      (contacts_done / kpi_fact over time) into avgPerDay / forecast / on-track.
 *   2) `loadContactsPaceData` / `loadKpiPaceData` — thin data loaders that hit
 *      `project_contacts_history` and feed `computePace`.
 *
 * The loaders take a minimal `PaceQueryClient` interface instead of a full
 * `SupabaseClient` so they can be unit-tested without the supabase-js
 * runtime. Production wiring just passes the supabase client directly.
 *
 * Pinned contracts (regression tests in `app/tests/lib/paceCalculator.test.ts`):
 *   - Query is ordered by `recorded_at` DESCENDING and limited to
 *     `PACE_HISTORY_LIMIT` rows. Without that the tooltip used to compute
 *     темп over the OLDEST 90 days, ignoring everything past day 90.
 *   - `computePace` is fed history in any order; it sorts internally.
 */
export const PACE_HISTORY_LIMIT = 90;

export interface PaceHistoryPoint {
  value: number;
  recorded_at: string;
}

export interface PaceData {
  avgPerDay: number;
  remaining: number;
  forecastDays: number | null;
  forecastDate: string | null;
  deadline: string | null;
  onTrack: boolean | null;
  requiredPace: number | null;
  dataPoints: number;
  periodDays: number;
}

/**
 * Compute pace stats from a series of cumulative snapshots.
 *
 * `history` may arrive in any order (DB query is DESC, but tooltip code can
 * also pass arbitrary fixtures); we sort internally by recorded_at ASC.
 *
 * Velocity is computed across the full window: (last - first) / daysDiff.
 * Returns `avgPerDay = 0` and forecast = null if there's <2 points or if
 * delta and daysDiff don't yield a positive forward velocity.
 */
export function computePace(
  history: readonly PaceHistoryPoint[],
  obligation: number,
  currentDone: number,
  deadline: string | null,
  /** Treated as "now" for forecast & on-track calculations. Defaults to Date.now(). */
  now: Date = new Date(),
): PaceData {
  const sorted = [...history].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const remaining = Math.max(0, obligation - currentDone);
  const base: PaceData = {
    avgPerDay: 0,
    remaining,
    forecastDays: null,
    forecastDate: null,
    deadline,
    onTrack: null,
    requiredPace: null,
    dataPoints: sorted.length,
    periodDays: 0,
  };
  if (sorted.length < 2) return base;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const daysDiff = Math.max(
    1,
    Math.round(
      (new Date(last.recorded_at).getTime() - new Date(first.recorded_at).getTime()) / 86_400_000,
    ),
  );
  const delta = last.value - first.value;
  const avgPerDay = Math.round(delta / daysDiff);
  base.avgPerDay = avgPerDay;
  base.periodDays = daysDiff;

  if (avgPerDay > 0 && remaining > 0) {
    const forecastDays = Math.ceil(remaining / avgPerDay);
    const forecastDate = new Date(now.getTime() + forecastDays * 86_400_000);
    base.forecastDays = forecastDays;
    base.forecastDate = forecastDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } else if (remaining === 0) {
    base.forecastDays = 0;
    base.forecastDate = 'выполнено';
  }

  if (deadline) {
    const dlDate = new Date(deadline);
    if (!isNaN(dlDate.getTime())) {
      const daysUntilDeadline = Math.max(0, Math.ceil((dlDate.getTime() - now.getTime()) / 86_400_000));
      base.requiredPace = daysUntilDeadline > 0 ? Math.ceil(remaining / daysUntilDeadline) : null;
      if (base.forecastDays !== null) {
        base.onTrack = base.forecastDays <= daysUntilDeadline;
      }
    }
  }
  return base;
}

/* ── Data loaders ─────────────────────────────────────────────────────── */

/**
 * Minimal subset of supabase-js builder methods the loaders rely on.
 * Kept tiny on purpose so unit tests can stub it without bringing in a
 * full Supabase mock.
 *
 * `from` returns `unknown` because supabase's real `SupabaseClient.from`
 * has a much richer generic shape we don't want to mirror — the loader
 * casts to the concrete `PaceQueryBuilder<Row>` after `from(...)`.
 */
export interface PaceQueryBuilder<T> {
  select(columns: string): PaceQueryBuilder<T>;
  eq(column: string, value: unknown): PaceQueryBuilder<T>;
  not(column: string, op: string, value: unknown): PaceQueryBuilder<T>;
  order(column: string, opts: { ascending: boolean }): PaceQueryBuilder<T>;
  limit(n: number): Promise<{ data: T[] | null; error: { message: string } | null }>;
}

export interface PaceQueryClient {
  from(table: string): unknown;
}

interface ContactsHistoryRow {
  contacts_done: number;
  recorded_at: string;
}

interface KpiHistoryRow {
  kpi_fact: number | null;
  recorded_at: string;
}

/**
 * Load contacts pace from `project_contacts_history`.
 *
 * IMPORTANT: query is DESC + LIMIT 90 — we want the LATEST 90 daily
 * snapshots, not the oldest. Tooltip used to use ASC + LIMIT 90 and
 * silently capped the analysis to a project's first three months.
 */
export async function loadContactsPaceData(
  client: PaceQueryClient,
  params: {
    projectId: string;
    obligation: number;
    done: number;
    deadline: string | null;
    now?: Date;
    limit?: number;
  },
): Promise<PaceData | null> {
  const { projectId, obligation, done, deadline } = params;
  const limit = params.limit ?? PACE_HISTORY_LIMIT;
  const builder = client.from('project_contacts_history') as PaceQueryBuilder<ContactsHistoryRow>;
  const { data, error } = await builder
    .select('contacts_done, recorded_at')
    .eq('project_id', projectId)
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error || !data) return null;
  const points: PaceHistoryPoint[] = data.map((r) => ({
    value: r.contacts_done,
    recorded_at: r.recorded_at,
  }));
  return computePace(points, obligation, done, deadline, params.now);
}

/**
 * Load KPI pace from `project_contacts_history` (kpi_fact column).
 *
 * Same DESC + LIMIT 90 contract as contacts. We additionally filter out
 * rows where `kpi_fact` is NULL (projects with no KPI snapshot for that
 * day still write a contacts row).
 */
export async function loadKpiPaceData(
  client: PaceQueryClient,
  params: {
    projectId: string;
    kpiPlan: number;
    kpiFact: number;
    deadline: string | null;
    now?: Date;
    limit?: number;
  },
): Promise<PaceData | null> {
  const { projectId, kpiPlan, kpiFact, deadline } = params;
  const limit = params.limit ?? PACE_HISTORY_LIMIT;
  const builder = client.from('project_contacts_history') as PaceQueryBuilder<KpiHistoryRow>;
  const { data, error } = await builder
    .select('kpi_fact, recorded_at')
    .eq('project_id', projectId)
    .not('kpi_fact', 'is', null)
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error || !data) return null;
  const points: PaceHistoryPoint[] = data
    .filter((r) => r.kpi_fact !== null)
    .map((r) => ({ value: r.kpi_fact as number, recorded_at: r.recorded_at }));
  return computePace(points, kpiPlan, kpiFact, deadline, params.now);
}
