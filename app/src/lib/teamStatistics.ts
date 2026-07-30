import { buildRenameMap, getAssigneeDisplayName } from '@/lib/projectAssignees';

export type StatisticsPeriodKind = 'month' | 'quarter' | 'half' | 'year';
export type StatisticsCoverageStatus = 'complete' | 'partial' | 'unavailable';
export type TeamProjectResult = 'met' | 'missed' | 'in_progress' | 'unclassified';

export interface ReportingPeriod {
  kind: StatisticsPeriodKind;
  start: string;
  end: string;
  label: string;
  previousAnchor: string;
  nextAnchor: string | null;
}

export interface StatisticsCoverage {
  status: StatisticsCoverageStatus;
  startsAt: string | null;
  asOf: string;
  periodComplete: boolean;
  message: string;
}

export interface TeamProjectHistoryRow {
  id: string;
  project_id: string;
  period_id: string | null;
  project_name: string | null;
  client: string | null;
  project_status: string | null;
  period_status: string | null;
  manager: string | null;
  specialist: string | null;
  specialist_user_id: string | null;
  kpi_plan: string | null;
  kpi_fact: string | null;
  launch_date: string | null;
  deadline: string | null;
  period_start: string | null;
  period_end: string | null;
  capture_source: 'initial' | 'project_trigger' | 'period_trigger' | string;
  captured_at: string;
}

export interface TeamKpiHistoryRow {
  project_id: string;
  period_id: string | null;
  kpi_fact: string | number | null;
  recorded_at: string;
}

export interface TeamStatisticsProfile {
  id: string;
  email: string | null;
  full_name: string | null;
}

export interface TeamStatisticsProjectRow {
  id: string;
  projectId: string;
  client: string | null;
  name: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  result: TeamProjectResult;
  kpiPlan: number | null;
  kpiFact: number | null;
  leads: number;
}

export interface PersonStats {
  id: string | null;
  name: string;
  projects: number;
  kpiMet: number;
  kpiMissed: number;
  inProgress: number;
  unclassified: number;
  leads: number;
  projectRows: TeamStatisticsProjectRow[];
}

export interface TeamStatisticsSummary {
  projects: number;
  kpiMet: number;
  kpiMissed: number;
  inProgress: number;
  unclassified: number;
  leads: number;
}

export interface TeamStatisticsData {
  summary: TeamStatisticsSummary;
  groups: {
    leads: PersonStats[];
    specialists: PersonStats[];
  };
}

export interface TeamStatisticsResponse extends TeamStatisticsData {
  period: ReportingPeriod;
  coverage: StatisticsCoverage;
}

export class TeamStatisticsInputError extends Error {}

const PERIOD_KINDS = new Set<StatisticsPeriodKind>(['month', 'quarter', 'half', 'year']);
const MONTH_NAMES_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;
const ROMAN = ['I', 'II', 'III', 'IV'] as const;
const BUSINESS_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const BUSINESS_UTC_OFFSET = '+03:00';

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function businessIsoDate(date: Date): string {
  return isoDate(new Date(date.getTime() + BUSINESS_UTC_OFFSET_MS));
}

export function teamStatisticsBusinessDate(value: string): string | null {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  return businessIsoDate(new Date(parsed));
}

function eventBusinessDate(value: string): string {
  return teamStatisticsBusinessDate(value) ?? value.slice(0, 10);
}

function businessDateBoundary(value: string, endOfDay = false): number {
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
  return new Date(`${value}T${time}${BUSINESS_UTC_OFFSET}`).getTime();
}


function utcDate(year: number, month: number, day = 1): Date {
  return new Date(Date.UTC(year, month, day));
}

function addUtcMonths(date: Date, months: number): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

function dayBefore(date: Date): Date {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000);
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && isoDate(parsed) === value ? parsed : null;
}

function assertPeriodKind(value: string | null | undefined): StatisticsPeriodKind {
  if (!value || !PERIOD_KINDS.has(value as StatisticsPeriodKind)) {
    throw new TeamStatisticsInputError('Unsupported statistics period');
  }
  return value as StatisticsPeriodKind;
}

function periodStartDate(kind: StatisticsPeriodKind, anchor: Date): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  if (kind === 'month') return utcDate(year, month);
  if (kind === 'quarter') return utcDate(year, Math.floor(month / 3) * 3);
  if (kind === 'half') return utcDate(year, month < 6 ? 0 : 6);
  return utcDate(year, 0);
}

function periodMonths(kind: StatisticsPeriodKind): number {
  if (kind === 'month') return 1;
  if (kind === 'quarter') return 3;
  if (kind === 'half') return 6;
  return 12;
}

function periodLabel(kind: StatisticsPeriodKind, start: Date): string {
  const year = start.getUTCFullYear();
  if (kind === 'month') return `${MONTH_NAMES_RU[start.getUTCMonth()]} ${year}`;
  if (kind === 'quarter') return `${ROMAN[Math.floor(start.getUTCMonth() / 3)]} квартал ${year}`;
  if (kind === 'half') return `${start.getUTCMonth() === 0 ? 'I' : 'II'} полугодие ${year}`;
  return `${year} год`;
}

export function resolveReportingPeriod(
  kindValue: string | null | undefined,
  anchorValue: string | null | undefined,
  now = new Date(),
): ReportingPeriod {
  const kind = assertPeriodKind(kindValue);
  const anchor = parseDateOnly(anchorValue);
  if (!anchor) throw new TeamStatisticsInputError('Invalid statistics anchor');

  const months = periodMonths(kind);
  const startDate = periodStartDate(kind, anchor);
  const nextDate = addUtcMonths(startDate, months);
  const currentAnchor = parseDateOnly(businessIsoDate(now));
  const currentStart = periodStartDate(kind, currentAnchor!);

  return {
    kind,
    start: isoDate(startDate),
    end: isoDate(dayBefore(nextDate)),
    label: periodLabel(kind, startDate),
    previousAnchor: isoDate(addUtcMonths(startDate, -months)),
    nextAnchor: nextDate.getTime() <= currentStart.getTime() ? isoDate(nextDate) : null,
  };
}

function displayIsoDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

export function getStatisticsCoverage(
  start: string,
  end: string,
  startsAt: string | null,
  today = businessIsoDate(new Date()),
): StatisticsCoverage {
  const asOf = end < today ? end : today;
  const periodComplete = end < today;

  if (!startsAt) {
    return {
      status: 'unavailable',
      startsAt: null,
      asOf,
      periodComplete,
      message: 'История пока не накоплена',
    };
  }
  if (end < startsAt) {
    return {
      status: 'unavailable',
      startsAt,
      asOf,
      periodComplete,
      message: 'История за этот период не собиралась',
    };
  }
  if (start <= startsAt) {
    return {
      status: 'partial',
      startsAt,
      asOf,
      periodComplete,
      message: `История собирается с ${displayIsoDate(startsAt)}; день запуска и более ранние данные неполные`,
    };
  }
  return {
    status: 'complete',
    startsAt,
    asOf,
    periodComplete,
    message: periodComplete
      ? 'Данные собраны за весь период'
      : `Данные полные по состоянию на ${displayIsoDate(asOf)}`,
  };
}
export function parseProjectMetric(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const match = String(value).replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function emptyTeamStatisticsData(): TeamStatisticsData {
  return {
    summary: {
      projects: 0,
      kpiMet: 0,
      kpiMissed: 0,
      inProgress: 0,
      unclassified: 0,
      leads: 0,
    },
    groups: { leads: [], specialists: [] },
  };
}

function assigneeKey(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase('ru-RU') ?? '';
}

interface PersonIdentity {
  id: string | null;
  name: string;
}

function buildProfileIndexes(profiles: TeamStatisticsProfile[]) {
  const assigneeProfiles = profiles.map((profile) => ({
    ...profile,
    email: profile.email ?? '',
    full_name: profile.full_name ?? undefined,
  }));
  const byId = new Map<string, PersonIdentity>();
  const byName = new Map<string, PersonIdentity>();

  for (const profile of assigneeProfiles) {
    const name = getAssigneeDisplayName(profile);
    if (!name) continue;
    const identity = { id: profile.id, name };
    byId.set(profile.id, identity);
    byName.set(assigneeKey(name), identity);
    if (profile.email) byName.set(assigneeKey(profile.email), identity);
  }

  for (const [staleName, currentName] of buildRenameMap(assigneeProfiles)) {
    const identity = byName.get(assigneeKey(currentName));
    if (identity) byName.set(assigneeKey(staleName), identity);
  }

  return { byId, byName };
}

function resolvePerson(
  value: string | null,
  profileId: string | null,
  fallbackName: string,
  indexes: ReturnType<typeof buildProfileIndexes>,
): PersonIdentity {
  if (profileId) {
    const byId = indexes.byId.get(profileId);
    if (byId) return byId;
  }
  const normalized = value?.trim() ?? '';
  if (normalized) {
    const byName = indexes.byName.get(assigneeKey(normalized));
    if (byName) return byName;
    return { id: profileId, name: normalized };
  }
  return { id: profileId, name: fallbackName };
}

function cycleKey(row: Pick<TeamProjectHistoryRow, 'project_id' | 'period_id'>): string {
  return `${row.project_id}:${row.period_id ?? 'legacy'}`;
}

function timestamp(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTimestamps(left: string, right: string): number {
  return (timestamp(left) ?? Number.NEGATIVE_INFINITY)
    - (timestamp(right) ?? Number.NEGATIVE_INFINITY)
    || left.localeCompare(right);
}

function isPreparation(status: string | null): boolean {
  return assigneeKey(status).includes('подготов');
}

function isFinished(status: string | null): boolean {
  const normalized = assigneeKey(status);
  return normalized.includes('заверш') || normalized.includes('отмен') || normalized.includes('удал') || normalized === 'closed';
}

function resultFor(row: TeamProjectHistoryRow): TeamProjectResult {
  if (isPreparation(row.project_status)) return 'in_progress';
  const closed = row.period_status === 'closed' || isFinished(row.project_status);
  if (!closed) return 'in_progress';

  const plan = parseProjectMetric(row.kpi_plan);
  const fact = parseProjectMetric(row.kpi_fact);
  if (plan == null || plan <= 0 || fact == null || fact < 0) return 'unclassified';
  return fact >= plan ? 'met' : 'missed';
}

function effectiveCycleStart(row: TeamProjectHistoryRow): string {
  const captured = eventBusinessDate(row.captured_at);
  const planned = row.period_start ?? row.launch_date ?? captured;
  return isPreparation(row.project_status) && captured < planned ? captured : planned;
}

function effectiveCycleEnd(row: TeamProjectHistoryRow): string | null {
  if (row.period_end) return row.period_end;
  if (row.period_status === 'closed' || isFinished(row.project_status)) {
    return row.deadline ?? eventBusinessDate(row.captured_at);
  }
  return null;
}

function overlapsRange(row: TeamProjectHistoryRow, range: ReportingPeriod): boolean {
  const start = effectiveCycleStart(row);
  const end = effectiveCycleEnd(row);
  return start <= range.end && (end == null || end >= range.start);
}

function latestMetric<T>(rows: T[], value: (row: T) => string | number | null): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const parsed = parseProjectMetric(value(rows[index]));
    if (parsed != null) return parsed;
  }
  return null;
}

function leadsForRange(
  snapshots: TeamProjectHistoryRow[],
  latest: TeamProjectHistoryRow,
  kpiHistory: TeamKpiHistoryRow[],
  range: ReportingPeriod,
): number {
  if (isPreparation(latest.project_status)) return 0;

  const cycleStart = effectiveCycleStart(latest);
  const matchingKpi = kpiHistory
    .filter((row) => row.project_id === latest.project_id)
    .filter((row) => (
      row.period_id === latest.period_id
      || (latest.period_id != null && row.period_id == null && eventBusinessDate(row.recorded_at) >= cycleStart)
    ))
    .filter((row) => eventBusinessDate(row.recorded_at) <= range.end)
    .sort((a, b) => compareTimestamps(a.recorded_at, b.recorded_at));

  const frozenFact = latest.period_status === 'closed' || isFinished(latest.project_status)
    ? parseProjectMetric(latest.kpi_fact)
    : null;
  const factAtEnd = frozenFact
    ?? latestMetric(matchingKpi, (row) => row.kpi_fact)
    ?? latestMetric(snapshots, (row) => row.kpi_fact);
  if (factAtEnd == null || factAtEnd < 0) return 0;

  const preparationBaseline = latestMetric(
    snapshots.filter((row) => (
      isPreparation(row.project_status) && eventBusinessDate(row.captured_at) >= range.start
    )),
    (row) => row.kpi_fact,
  );

  if (cycleStart >= range.start) {
    return Math.max(0, factAtEnd - (preparationBaseline ?? 0));
  }

  const rangeStartMs = businessDateBoundary(range.start);
  const beforeStartSnapshots = snapshots.filter((row) => {
    const value = timestamp(row.captured_at);
    return value != null && value < rangeStartMs;
  });
  let baseline = latestMetric(beforeStartSnapshots, (row) => row.kpi_fact);

  if (baseline == null) {
    baseline = latestMetric(
      matchingKpi.filter((row) => eventBusinessDate(row.recorded_at) < range.start),
      (row) => row.kpi_fact,
    );
  }

  if (baseline == null) {
    const firstInRange = matchingKpi.find((row) => eventBusinessDate(row.recorded_at) >= range.start);
    baseline = firstInRange ? parseProjectMetric(firstInRange.kpi_fact) : null;
  }

  if (preparationBaseline != null) baseline = Math.max(baseline ?? 0, preparationBaseline);
  if (baseline == null) return 0;
  return Math.max(0, factAtEnd - baseline);
}

function newPersonStats(identity: PersonIdentity): PersonStats {
  return {
    ...identity,
    projects: 0,
    kpiMet: 0,
    kpiMissed: 0,
    inProgress: 0,
    unclassified: 0,
    leads: 0,
    projectRows: [],
  };
}

function incrementResult(target: TeamStatisticsSummary | PersonStats, result: TeamProjectResult): void {
  if (result === 'met') target.kpiMet += 1;
  else if (result === 'missed') target.kpiMissed += 1;
  else if (result === 'in_progress') target.inProgress += 1;
  else target.unclassified += 1;
}

function personMapKey(identity: PersonIdentity): string {
  return identity.id ? `id:${identity.id}` : `name:${assigneeKey(identity.name)}`;
}

function addToPerson(
  map: Map<string, PersonStats>,
  identity: PersonIdentity,
  project: TeamStatisticsProjectRow,
): void {
  const key = personMapKey(identity);
  const person = map.get(key) ?? newPersonStats(identity);
  person.leads += project.leads;
  incrementResult(person, project.result);
  person.projectRows.push(project);
  map.set(key, person);
}

function sortedPeople(map: Map<string, PersonStats>): PersonStats[] {
  return Array.from(map.values())
    .map((person) => ({
      ...person,
      projects: new Set(person.projectRows.map((project) => project.projectId)).size,
      projectRows: person.projectRows.slice().sort((a, b) => (
        (a.client ?? a.name).localeCompare(b.client ?? b.name, 'ru-RU')
        || (a.periodStart ?? '').localeCompare(b.periodStart ?? '')
      )),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
}

interface SelectedCycle {
  identity: TeamProjectHistoryRow;
  metrics: TeamProjectHistoryRow;
  metricSnapshots: TeamProjectHistoryRow[];
}

function selectCycleForRange(
  snapshots: TeamProjectHistoryRow[],
  range: ReportingPeriod,
  endMs: number,
): SelectedCycle | null {
  const atPeriodEnd = snapshots.filter((row) => {
    const capturedAt = timestamp(row.captured_at);
    return capturedAt != null && capturedAt <= endMs;
  });
  const identity = atPeriodEnd.at(-1);
  const closedAfterPeriod = snapshots.filter((row) => {
    const capturedAt = timestamp(row.captured_at);
    if (capturedAt == null || capturedAt <= endMs) return false;
    if (row.period_status !== 'closed' && !isFinished(row.project_status)) return false;
    const semanticEnd = effectiveCycleEnd(row);
    return semanticEnd != null && semanticEnd <= range.end;
  });
  const metrics = closedAfterPeriod.at(-1) ?? identity;
  const periodIdentity = identity ?? metrics;
  if (!metrics || !periodIdentity || !overlapsRange(metrics, range)) return null;

  const semanticClosed = new Set(closedAfterPeriod);
  return {
    identity: periodIdentity,
    metrics,
    metricSnapshots: snapshots.filter((row) => {
      const capturedAt = timestamp(row.captured_at);
      return capturedAt != null && (capturedAt <= endMs || semanticClosed.has(row));
    }),
  };
}

export function buildTeamStatistics(input: {
  range: ReportingPeriod;
  history: TeamProjectHistoryRow[];
  profiles: TeamStatisticsProfile[];
  kpiHistory?: TeamKpiHistoryRow[];
}): TeamStatisticsData {
  const endMs = businessDateBoundary(input.range.end, true);
  const grouped = new Map<string, TeamProjectHistoryRow[]>();

  for (const row of input.history) {
    if (timestamp(row.captured_at) == null) continue;
    const key = cycleKey(row);
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }

  const selectedCycles: SelectedCycle[] = [];
  for (const snapshots of grouped.values()) {
    snapshots.sort((a, b) => (
      compareTimestamps(a.captured_at, b.captured_at) || a.id.localeCompare(b.id)
    ));
    const selected = selectCycleForRange(snapshots, input.range, endMs);
    if (selected) selectedCycles.push(selected);
  }

  const explicitCycleStartByProject = new Map<string, string>();
  for (const row of input.history) {
    if (row.period_id == null) continue;
    const start = effectiveCycleStart(row);
    const previous = explicitCycleStartByProject.get(row.project_id);
    if (!previous || start < previous) {
      explicitCycleStartByProject.set(row.project_id, start);
    }
  }
  const indexes = buildProfileIndexes(input.profiles);
  const leadGroups = new Map<string, PersonStats>();
  const specialistGroups = new Map<string, PersonStats>();
  const summary = emptyTeamStatisticsData().summary;
  const summaryProjectIds = new Set<string>();

  for (const selected of selectedCycles) {
    const { identity, metrics, metricSnapshots } = selected;
    const explicitCycleStart = explicitCycleStartByProject.get(metrics.project_id);
    if (
      metrics.period_id == null
      && explicitCycleStart != null
      && explicitCycleStart <= input.range.end
    ) continue;

    const result = resultFor(metrics);
    const leads = leadsForRange(metricSnapshots, metrics, input.kpiHistory ?? [], input.range);
    const project: TeamStatisticsProjectRow = {
      id: metrics.period_id ? `${metrics.project_id}:${metrics.period_id}` : metrics.project_id,
      projectId: metrics.project_id,
      client: identity.client,
      name: identity.project_name?.trim() || 'Без названия',
      status: metrics.project_status?.trim() || metrics.period_status?.trim() || 'Без статуса',
      periodStart: metrics.period_start,
      periodEnd: effectiveCycleEnd(metrics),
      result,
      kpiPlan: parseProjectMetric(metrics.kpi_plan),
      kpiFact: parseProjectMetric(metrics.kpi_fact),
      leads,
    };

    summaryProjectIds.add(metrics.project_id);
    summary.leads += leads;
    incrementResult(summary, result);

    addToPerson(
      leadGroups,
      resolvePerson(identity.manager, null, 'Без лида', indexes),
      project,
    );
    addToPerson(
      specialistGroups,
      resolvePerson(identity.specialist, identity.specialist_user_id, 'Без специалиста', indexes),
      project,
    );
  }

  summary.projects = summaryProjectIds.size;

  return {
    summary,
    groups: {
      leads: sortedPeople(leadGroups),
      specialists: sortedPeople(specialistGroups),
    },
  };
}
