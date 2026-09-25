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
  /** Usable snapshots after the latest reset/correction of the cumulative counter. */
  dataPoints: number;
  periodDays: number;
  /**
   * forecastDays - daysUntilDeadline. Positive ⇒ behind schedule; ≤0 ⇒ on time.
   * `null` when there's no deadline / no forecast / not enough data.
   */
  behindDays: number | null;
}

/**
 * Compute pace stats from a series of cumulative snapshots.
 *
 * `history` may arrive in any order (DB query is DESC, but tooltip code can
 * also pass arbitrary fixtures); we sort internally by recorded_at ASC.
 *
 * Velocity is (last - first) / daysDiff within the latest nondecreasing
 * segment. A decrease starts a new baseline: old totals must not turn a
 * counter reset/correction into negative production speed.
 * With <2 usable points or no elapsed days, pace is unknown (avgPerDay = 0,
 * forecast = null). Callers must not interpret that as confirmed zero pace.
 */
export function computePace(
  history: readonly PaceHistoryPoint[],
  obligation: number,
  currentDone: number,
  deadline: string | null,
  /** Treated as "now" for forecast & on-track calculations. Defaults to Date.now(). */
  now: Date = new Date(),
): PaceData {
  const ordered = [...history].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  let segmentStart = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].value < ordered[i - 1].value) segmentStart = i;
  }
  // A manual reset can precede the next daily snapshot. Until it is recorded,
  // none of the old history establishes the pace of the current counter.
  const lastSnapshot = ordered[ordered.length - 1];
  const sorted = lastSnapshot && currentDone < lastSnapshot.value
    ? []
    : ordered.slice(segmentStart);
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
    behindDays: null,
  };
  if (sorted.length < 2) return base;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const daysDiff = Math.round(
    (new Date(last.recorded_at).getTime() - new Date(first.recorded_at).getTime()) / 86_400_000,
  );
  if (daysDiff <= 0) return base;
  const delta = last.value - first.value;
  // Раньше тут было Math.round(delta / daysDiff) — для KPI/лидов это режет
  // до 0 любой темп < 0.5/день (типично для b2b: 3 лида за 14 дней = 0.21,
  // round → 0, прогноз null, UI «темп 0, нет данных»). По состоянию мая 2026
  // это касалось 22% всех проектов с KPI-историей. Считаем дробным,
  // форматирование на стороне UI.
  const avgPerDay = delta / daysDiff;
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
      const daysUntilDeadline = Math.ceil((dlDate.getTime() - now.getTime()) / 86_400_000);
      base.requiredPace = daysUntilDeadline > 0 ? Math.ceil(remaining / daysUntilDeadline) : null;
      if (base.forecastDays !== null) {
        // Fulfilled obligations are not at risk. For unfinished ones, include
        // days already overdue instead of treating the deadline as today.
        base.onTrack = remaining === 0 || base.forecastDays <= daysUntilDeadline;
        base.behindDays = remaining === 0 ? 0 : base.forecastDays - daysUntilDeadline;
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
  in(column: string, values: readonly unknown[]): PaceQueryBuilder<T>;
  gte(column: string, value: unknown): PaceQueryBuilder<T>;
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
    periodId?: string | null;
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
  let query = builder
    .select('contacts_done, recorded_at')
    .eq('project_id', projectId);
  if (params.periodId) {
    query = query.eq('period_id', params.periodId);
  }
  const { data, error } = await query
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
    periodId?: string | null;
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
  let query = builder
    .select('kpi_fact, recorded_at')
    .eq('project_id', projectId)
    .not('kpi_fact', 'is', null);
  if (params.periodId) {
    query = query.eq('period_id', params.periodId);
  }
  const { data, error } = await query
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error || !data) return null;
  const points: PaceHistoryPoint[] = data
    .filter((r) => r.kpi_fact !== null)
    .map((r) => ({ value: r.kpi_fact as number, recorded_at: r.recorded_at }));
  return computePace(points, kpiPlan, kpiFact, deadline, params.now);
}

/* ── Bulk pace + risk summary (для индикатора риска в списке проектов) ── */

/** Окно истории, в котором считаем темп. ~3 месяца — достаточно для большинства проектов. */
export const PACE_HISTORY_WINDOW_DAYS = 90;

export interface ProjectPaceInput {
  projectId: string;
  /** Active project period. When present, pace history is isolated to this period. */
  periodId?: string | null;
  /** Плановый объём контактов (`projects.contacts_obligation`, после parseInt). 0 ⇒ ось контактов отключена. */
  contactsObligation: number;
  /** Текущий факт контактов (`projects.contacts_done`, после parseInt). */
  contactsDone: number;
  /** Плановый KPI лидов (`projects.kpi_plan`, после parseInt). 0 ⇒ ось KPI отключена. */
  kpiPlan: number;
  /** Текущий факт KPI (`projects.kpi_fact`, после parseInt). */
  kpiFact: number;
  deadline: string | null;
}

export interface ProjectPace {
  /** `null` если у проекта нет contactsObligation (>0). */
  contacts: PaceData | null;
  /** `null` если у проекта нет kpiPlan (>0). */
  kpi: PaceData | null;
}

export type RiskAxis = 'contacts' | 'kpi';

/**
 * Допуск отставания в днях: проект считается проблемным только если прогноз
 * промахивается мимо дедлайна БОЛЬШЕ чем на столько дней.
 *
 * Зачем: прогноз строится по средней скорости за окно истории и по своей
 * природе шумный — пара медленных дней на 3-месячном проекте легко даёт
 * «отставание» в 2–5 дней, которое закрывается само. Без допуска фильтр
 * «Проблемные» наполнялся пограничными проектами и переставал читаться как
 * сигнал. Неделя — минимальный отрезок, который команда реально успевает
 * отыграть (и на который смещается любой перенос созвона/выгрузки).
 */
export const RISK_GRACE_DAYS = 7;

export interface ProjectRiskSummary {
  /** Какие оси не успевают (forecast > deadline). Пустой массив ⇒ риска нет. */
  axes: RiskAxis[];
  /** Максимальное отставание в днях по проблемным осям. 0 если рисков нет. */
  daysBehind: number;
}

/**
 * Один batch-запрос истории за последние `PACE_HISTORY_WINDOW_DAYS` дней
 * для всех заданных проектов сразу. Группирует строки в JS и считает
 * `computePace` для каждого проекта (отдельно по контактам и по KPI).
 *
 * Пишется специально под список проектов — один round-trip на всю страницу
 * вместо on-hover запросов в существующих tooltip'ах.
 */
export async function loadAllProjectsPace(
  client: PaceQueryClient,
  inputs: readonly ProjectPaceInput[],
  now: Date = new Date(),
): Promise<Map<string, ProjectPace>> {
  const result = new Map<string, ProjectPace>();
  if (inputs.length === 0) return result;

  const cutoffDate = new Date(now.getTime() - PACE_HISTORY_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  type Row = {
    project_id: string;
    period_id?: string | null;
    contacts_done: number;
    kpi_fact: number | null;
    recorded_at: string;
  };

  const rows: Row[] = [];
  const periodIds = [
    ...new Set(inputs.map((i) => i.periodId).filter((id): id is string => !!id)),
  ];
  const legacyProjectIds = [
    ...new Set(inputs.filter((i) => !i.periodId).map((i) => i.projectId)),
  ];

  if (periodIds.length > 0) {
    const builder = client.from('project_contacts_history') as PaceQueryBuilder<Row>;
    const { data, error } = await builder
      .select('project_id, period_id, contacts_done, kpi_fact, recorded_at')
      .in('period_id', periodIds)
      .gte('recorded_at', cutoffDate)
      .order('recorded_at', { ascending: false })
      .limit(periodIds.length * PACE_HISTORY_WINDOW_DAYS);
    if (error || !data) return result;
    rows.push(...data);
  }

  if (legacyProjectIds.length > 0) {
    const builder = client.from('project_contacts_history') as PaceQueryBuilder<Row>;
    const { data, error } = await builder
      .select('project_id, contacts_done, kpi_fact, recorded_at')
      .in('project_id', legacyProjectIds)
      .gte('recorded_at', cutoffDate)
      .order('recorded_at', { ascending: false })
      // верхняя граница; в реальности per-project уже отсечено окном дат
      .limit(legacyProjectIds.length * PACE_HISTORY_WINDOW_DAYS);
    if (error || !data) return result;
    rows.push(...data);
  }

  const rowsByProject = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.period_id ? `period:${row.period_id}` : `project:${row.project_id}`;
    const list = rowsByProject.get(key);
    if (list) list.push(row);
    else rowsByProject.set(key, [row]);
  }

  for (const input of inputs) {
    const key = input.periodId ? `period:${input.periodId}` : `project:${input.projectId}`;
    const projectRows = rowsByProject.get(key) ?? [];
    const contactsPoints: PaceHistoryPoint[] = projectRows.map((r) => ({
      value: r.contacts_done,
      recorded_at: r.recorded_at,
    }));
    const kpiPoints: PaceHistoryPoint[] = projectRows
      .filter((r): r is Row & { kpi_fact: number } => r.kpi_fact !== null)
      .map((r) => ({ value: r.kpi_fact, recorded_at: r.recorded_at }));

    const contacts =
      input.contactsObligation > 0
        ? computePace(contactsPoints, input.contactsObligation, input.contactsDone, input.deadline, now)
        : null;
    const kpi =
      input.kpiPlan > 0
        ? computePace(kpiPoints, input.kpiPlan, input.kpiFact, input.deadline, now)
        : null;
    result.set(input.projectId, { contacts, kpi });
  }

  return result;
}

/**
 * Сводка риска для строки проекта в UI.
 * Возвращает пустые axes (риска нет), если:
 *   - проект завершён/отменён,
 *   - нет dедлайна или меньше 2 точек истории (`onTrack === null`),
 *   - оба `onTrack === true`,
 *   - отставание укладывается в допуск `graceDays` (см. `RISK_GRACE_DAYS`).
 *
 * `graceDays` — сколько дней отставания прощаем. Ось попадает в риск только
 * при `behindDays > graceDays`, поэтому «промахнулись на 3 дня» больше не
 * красит проект в проблемный. Передайте 0, чтобы получить старое поведение
 * (любое отставание = риск).
 */
export function summarizeProjectRisk(
  pace: ProjectPace | undefined,
  isCompleted: boolean,
  graceDays: number = RISK_GRACE_DAYS,
): ProjectRiskSummary {
  const empty: ProjectRiskSummary = { axes: [], daysBehind: 0 };
  if (!pace || isCompleted) return empty;

  const axes: RiskAxis[] = [];
  let daysBehind = 0;
  const isBehind = (data: PaceData | null): data is PaceData & { behindDays: number } =>
    !!data && data.onTrack === false && data.behindDays !== null && data.behindDays > graceDays;

  if (isBehind(pace.contacts)) {
    axes.push('contacts');
    if (pace.contacts.behindDays > daysBehind) daysBehind = pace.contacts.behindDays;
  }
  if (isBehind(pace.kpi)) {
    axes.push('kpi');
    if (pace.kpi.behindDays > daysBehind) daysBehind = pace.kpi.behindDays;
  }
  return { axes, daysBehind };
}

/**
 * Project filter: overdue obligations, forecast delay, or a stalled near-term
 * target. Loading failures and insufficient post-reset history are unknown
 * pace, not evidence of a stalled project. Hard overdue obligations remain
 * visible even when history is unavailable.
 */
export function isProjectAtRisk(
  input: Pick<ProjectPaceInput, 'contactsObligation' | 'contactsDone' | 'kpiPlan' | 'kpiFact' | 'deadline'>,
  pace: ProjectPace | undefined,
  isCompleted: boolean,
  now: Date = new Date(),
): boolean {
  if (isCompleted) return false;

  const contactsOblig = input.contactsObligation;
  const contactsDone = input.contactsDone;
  const kpiPlan = input.kpiPlan;
  const kpiFact = input.kpiFact;

  // У проекта вообще нет обязательств — никогда не проблемный.
  if (contactsOblig === 0 && kpiPlan === 0) return false;

  const deadlineStr = input.deadline?.trim();
  let daysUntilDeadline: number | null = null;
  if (deadlineStr) {
    const dl = new Date(deadlineStr);
    if (!isNaN(dl.getTime())) {
      daysUntilDeadline = Math.ceil((dl.getTime() - now.getTime()) / 86_400_000);
    }
  }

  // 1) HARD-FAILURE: дедлайн в прошлом больше чем на допуск, не доехали.
  if (daysUntilDeadline !== null && daysUntilDeadline < -RISK_GRACE_DAYS) {
    if (contactsOblig > 0 && contactsDone < contactsOblig) return true;
    if (kpiPlan > 0 && kpiFact < kpiPlan) return true;
  }

  // 2) PACE-BASED (форкаст видим только если есть история).
  const risk = summarizeProjectRisk(
    pace,
    false, // isCompleted уже отсеян выше
  );
  if (risk.axes.length > 0) return true;

  // 3) ZERO-PACE: дедлайн ≤14 дней (включая просроченный), и отсутствие
  //    роста подтверждено хотя бы двумя снимками после последнего сброса.
  if (daysUntilDeadline !== null && daysUntilDeadline <= 14) {
    const contactsRemaining = Math.max(0, contactsOblig - contactsDone);
    const kpiRemaining = Math.max(0, kpiPlan - kpiFact);
    const isStalled = (data: PaceData | null | undefined): boolean =>
      !!data && data.dataPoints >= 2 && data.periodDays > 0 && data.avgPerDay <= 0;
    if (contactsOblig > 0 && contactsRemaining > 0) {
      if (isStalled(pace?.contacts)) return true;
    }
    if (kpiPlan > 0 && kpiRemaining > 0) {
      if (isStalled(pace?.kpi)) return true;
    }
  }

  return false;
}
