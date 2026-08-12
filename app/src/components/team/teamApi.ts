'use client';

import { supabase } from '@/lib/supabaseClient';

export type TeamPeriodKind = 'month' | 'quarter' | 'half' | 'year';
export type TeamCoverageStatus = 'complete' | 'partial' | 'unavailable';
export type TeamProjectResult = 'met' | 'missed' | 'in_progress' | 'unclassified';

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

export interface TeamPersonStatistics {
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

export interface TeamStatisticsResponse {
  period: {
    kind: TeamPeriodKind;
    start: string;
    end: string;
    label: string;
    previousAnchor: string;
    nextAnchor: string | null;
  };
  coverage: {
    status: TeamCoverageStatus;
    startsAt: string | null;
    asOf: string;
    periodComplete: boolean;
    message: string;
  };
  summary: {
    projects: number;
    kpiMet: number;
    kpiMissed: number;
    inProgress: number;
    unclassified: number;
    leads: number;
  };
  groups: {
    leads: TeamPersonStatistics[];
    specialists: TeamPersonStatistics[];
  };
}

export interface TeamReviewEmployee {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  avatarUrl: string | null;
}

export type TeamReviewStatus = 'scheduled' | 'completed';

export interface TeamReview {
  id: string;
  reviewDate: string;
  employee: TeamReviewEmployee | null;
  candidateName: string | null;
  reviewer: TeamReviewEmployee | null;
  status: TeamReviewStatus;
  reason: string | null;
  outcomes: string | null;
  problems: string | null;
  recommendations: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamReviewsResponse {
  reviews: TeamReview[];
  employees: TeamReviewEmployee[];
  canManage: boolean;
  currentUserId: string | null;
}

export type TeamTalentReserveStage =
  | 'new'
  | 'test'
  | 'interview'
  | 'reserve'
  | 'return_later'
  | 'hired'
  | 'rejected'
  | 'archived';

export interface TeamTalentReserveEntry {
  id: string;
  contact: string;
  candidateName: string;
  vacancyDirection: string;
  testAssignment: string | null;
  testResult: string | null;
  testSentOn: string | null;
  interviewOn: string | null;
  comment: string | null;
  revisitOn: string | null;
  revisitNote: string | null;
  stage: TeamTalentReserveStage;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamTalentReserveResponse {
  entries: TeamTalentReserveEntry[];
  summary: {
    total: number;
    attentionCount: number;
    activeCount: number;
    historyCount: number;
  };
  asOf: string;
  canManage: boolean;
}

export interface TeamTalentReserveInput {
  contact: string;
  candidateName: string;
  vacancyDirection: string;
  testAssignment?: string | null;
  testResult?: string | null;
  testSentOn?: string | null;
  interviewOn?: string | null;
  comment?: string | null;
  revisitOn?: string | null;
  revisitNote?: string | null;
  stage: TeamTalentReserveStage;
}

export interface TeamTalentReserveWrite {
  contact: string;
  candidateName: string;
  vacancyDirection: string;
  testAssignment: string | null;
  testResult: string | null;
  testSentOn: string | null;
  interviewOn: string | null;
  comment: string | null;
  revisitOn: string | null;
  revisitNote: string | null;
  stage: TeamTalentReserveStage;
}

export type TeamReviewRequestState = 'new' | 'in_progress' | 'converted' | 'declined';

export interface TeamReviewRequestPerson {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface TeamReviewRequestProject {
  id: string;
  name: string;
}

export interface TeamReviewRequest {
  id: string;
  state: TeamReviewRequestState;
  employee: TeamReviewRequestPerson | null;
  initiator: TeamReviewRequestPerson | null;
  project: TeamReviewRequestProject | null;
  problem: string;
  examples: string | null;
  desiredOutcome: string;
  claimedBy: TeamReviewRequestPerson | null;
  claimedAt: string | null;
  linkedReviewId: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamReviewRequestGroup {
  state: TeamReviewRequestState;
  requests: TeamReviewRequest[];
}

export interface TeamReviewRequestSummary {
  total: number;
  newCount: number;
  inProgressCount: number;
  convertedCount: number;
  declinedCount: number;
}

export interface TeamReviewRequestsResponse {
  groups: TeamReviewRequestGroup[];
  summary: TeamReviewRequestSummary;
  employees: TeamReviewRequestPerson[];
  projects: TeamReviewRequestProject[];
  canManage: boolean;
}

export interface TeamReviewRequestInput {
  employeeUserId: string;
  projectId?: string | null;
  problem: string;
  examples?: string | null;
  desiredOutcome: string;
}

export interface TeamReviewRequestWrite {
  employeeUserId: string;
  projectId: string | null;
  problem: string;
  examples: string | null;
  desiredOutcome: string;
}

export interface TeamReviewRequestActionInput {
  action: 'claim' | 'decline';
  decisionNote?: string | null;
  expectedUpdatedAt: string;
}

export interface TeamReviewRequestActionWrite {
  action: 'claim' | 'decline';
  decisionNote?: string | null;
  expectedUpdatedAt: string;
}

export interface TeamReviewRequestConversionInput {
  reviewDate: string;
  reviewReason: string;
  expectedUpdatedAt: string;
}

export interface TeamReviewRequestConversionWrite {
  reviewDate: string;
  reviewReason: string;
  expectedUpdatedAt: string;
}

export type TeamActivityPlanStatus = 'planned' | 'completed' | 'cancelled';
export type TeamActivityPlanTimingType = 'date' | 'schedule' | 'none';

export interface TeamActivityPlanItem {
  id: string;
  planMonth: string;
  periodicity: string;
  activity: string;
  format: string | null;
  plannedDate: string | null;
  plannedTime: string | null;
  scheduleNote: string | null;
  note: string | null;
  budgetAmount: number | null;
  budgetNote: string | null;
  status: TeamActivityPlanStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamActivityPlanResponse {
  period: {
    month: string;
    label: string;
    previousMonth: string;
    nextMonth: string;
  };
  items: TeamActivityPlanItem[];
  summary: {
    total: number;
    planned: number;
    completed: number;
    cancelled: number;
    overdue: number;
    budgetAmount: number;
    budgetUnspecified: number;
  };
  asOf: string;
  canManage: boolean;
}

export interface TeamActivityPlanInput {
  timingType: TeamActivityPlanTimingType;
  planMonth: string;
  periodicity: string;
  activity: string;
  format?: string | null;
  plannedDate?: string | null;
  plannedTime?: string | null;
  scheduleNote?: string | null;
  note?: string | null;
  budgetAmount?: string | number | null;
  budgetNote?: string | null;
  status: TeamActivityPlanStatus;
  position: number;
}

export interface TeamActivityPlanWrite {
  planMonth: string;
  periodicity: string;
  activity: string;
  format: string | null;
  plannedDate: string | null;
  plannedTime: string | null;
  scheduleNote: string | null;
  note: string | null;
  budgetAmount: number | null;
  budgetNote: string | null;
  status: TeamActivityPlanStatus;
  position: number;
}

interface TeamReviewScheduleInputBase {
  reviewDate: string;
  reason?: string | null;
}

export type TeamReviewScheduleInput =
  | (TeamReviewScheduleInputBase & {
      subjectType: 'employee';
      employeeUserId: string;
      candidateName?: never;
    })
  | (TeamReviewScheduleInputBase & {
      subjectType: 'candidate';
      candidateName: string;
      employeeUserId?: never;
    });

export type TeamReviewScheduleWrite =
  | {
      reviewDate: string;
      employeeUserId: string;
      reason: string | null;
    }
  | {
      reviewDate: string;
      candidateName: string;
      reason: string | null;
    };

export interface TeamReviewCompletionInput {
  outcomes: string;
  problems?: string | null;
  recommendations?: string | null;
}

export interface TeamReviewCompletionWrite {
  status: 'completed';
  outcomes: string;
  problems: string | null;
  recommendations: string | null;
}


function trimmedOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function buildTeamReviewScheduleWrite(
  values: TeamReviewScheduleInput,
): TeamReviewScheduleWrite {
  const common = {
    reviewDate: values.reviewDate,
    reason: trimmedOrNull(values.reason),
  };
  return values.subjectType === 'candidate'
    ? { ...common, candidateName: values.candidateName.trim() }
    : { ...common, employeeUserId: values.employeeUserId };
}

export function buildTeamReviewCompletionWrite(
  values: TeamReviewCompletionInput,
): TeamReviewCompletionWrite {
  return {
    status: 'completed',
    outcomes: values.outcomes.trim(),
    problems: trimmedOrNull(values.problems),
    recommendations: trimmedOrNull(values.recommendations),
  };
}

export function buildTeamTalentReserveWrite(
  values: TeamTalentReserveInput,
): TeamTalentReserveWrite {
  const keepsReturnReminder = values.stage === 'return_later';
  return {
    contact: values.contact.trim(),
    candidateName: values.candidateName.trim(),
    vacancyDirection: values.vacancyDirection.trim(),
    testAssignment: trimmedOrNull(values.testAssignment),
    testResult: trimmedOrNull(values.testResult),
    testSentOn: trimmedOrNull(values.testSentOn),
    interviewOn: trimmedOrNull(values.interviewOn),
    comment: trimmedOrNull(values.comment),
    revisitOn: keepsReturnReminder ? trimmedOrNull(values.revisitOn) : null,
    revisitNote: keepsReturnReminder ? trimmedOrNull(values.revisitNote) : null,
    stage: values.stage,
  };
}

export function buildTeamReviewRequestWrite(
  values: TeamReviewRequestInput,
): TeamReviewRequestWrite {
  return {
    employeeUserId: values.employeeUserId,
    projectId: trimmedOrNull(values.projectId),
    problem: values.problem.trim(),
    examples: trimmedOrNull(values.examples),
    desiredOutcome: values.desiredOutcome.trim(),
  };
}

export function buildTeamReviewRequestActionWrite(
  values: TeamReviewRequestActionInput,
): TeamReviewRequestActionWrite {
  return values.action === 'decline'
    ? {
        action: 'decline',
        decisionNote: trimmedOrNull(values.decisionNote),
        expectedUpdatedAt: values.expectedUpdatedAt,
      }
    : {
        action: 'claim',
        expectedUpdatedAt: values.expectedUpdatedAt,
      };
}

export function buildTeamReviewRequestConversionWrite(
  values: TeamReviewRequestConversionInput,
): TeamReviewRequestConversionWrite {
  return {
    reviewDate: values.reviewDate,
    reviewReason: values.reviewReason.trim(),
    expectedUpdatedAt: values.expectedUpdatedAt,
  };
}

export function buildTeamActivityPlanWrite(
  values: TeamActivityPlanInput,
): TeamActivityPlanWrite {
  const rawBudget = typeof values.budgetAmount === 'string'
    ? values.budgetAmount.trim()
    : values.budgetAmount;
  const parsedBudget = rawBudget === '' || rawBudget === null || rawBudget === undefined
    ? null
    : Number(rawBudget);
  const exactDate = values.timingType === 'date';
  const recurringSchedule = values.timingType === 'schedule';

  return {
    planMonth: values.planMonth,
    periodicity: values.periodicity.trim(),
    activity: values.activity.trim(),
    format: trimmedOrNull(values.format),
    plannedDate: exactDate ? trimmedOrNull(values.plannedDate) : null,
    plannedTime: exactDate ? trimmedOrNull(values.plannedTime) : null,
    scheduleNote: recurringSchedule ? trimmedOrNull(values.scheduleNote) : null,
    note: trimmedOrNull(values.note),
    budgetAmount: parsedBudget !== null && Number.isFinite(parsedBudget) ? parsedBudget : null,
    budgetNote: trimmedOrNull(values.budgetNote),
    status: values.status,
    position: Math.max(0, Math.trunc(values.position)),
  };
}

function activityPlanMonthDate(month: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11) return null;
  return new Date(Date.UTC(year, monthIndex, 1));
}

export function formatTeamActivityPlanMonth(month: string): string {
  const date = activityPlanMonthDate(month);
  if (!date) return month;
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date).replace(/\s*г\.$/, '');
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

export function shiftTeamActivityPlanMonth(month: string, offset: number): string {
  const date = activityPlanMonthDate(month);
  if (!date) return month;
  date.setUTCMonth(date.getUTCMonth() + offset);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}


type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export class TeamApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly payload: UnknownRecord;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'TeamApiError';
    this.status = status;
    this.payload = record(payload);
    this.code = nullableText(this.payload.code);
  }
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unwrap(payload: unknown): UnknownRecord {
  const outer = record(payload);
  return Object.keys(record(outer.data)).length ? record(outer.data) : outer;
}

function normalizeProject(value: unknown): TeamStatisticsProjectRow {
  const row = record(value);
  const result = text(row.result);
  return {
    id: text(row.id),
    projectId: text(row.projectId ?? row.project_id),
    client: nullableText(row.client),
    name: text(row.name, 'Без названия'),
    status: text(row.status),
    periodStart: nullableText(row.periodStart ?? row.period_start),
    periodEnd: nullableText(row.periodEnd ?? row.period_end),
    result: result === 'met' || result === 'missed' || result === 'in_progress'
      ? result
      : 'unclassified',
    kpiPlan: nullableNumber(row.kpiPlan ?? row.kpi_plan),
    kpiFact: nullableNumber(row.kpiFact ?? row.kpi_fact),
    leads: number(row.leads),
  };
}

function normalizePerson(value: unknown): TeamPersonStatistics {
  const person = record(value);
  const rows = Array.isArray(person.projectRows)
    ? person.projectRows.map(normalizeProject)
    : [];
  return {
    id: nullableText(person.id),
    name: text(person.name, 'Без имени'),
    projects: number(person.projects),
    kpiMet: number(person.kpiMet),
    kpiMissed: number(person.kpiMissed),
    inProgress: number(person.inProgress),
    unclassified: number(person.unclassified),
    leads: number(person.leads),
    projectRows: rows,
  };
}

export function normalizeStatistics(payload: unknown): TeamStatisticsResponse {
  const root = unwrap(payload);
  const period = record(root.period);
  const coverage = record(root.coverage);
  const summary = record(root.summary);
  const groups = record(root.groups);
  const kind = text(period.kind);
  const status = text(coverage.status);

  return {
    period: {
      kind: kind === 'quarter' || kind === 'half' || kind === 'year' ? kind : 'month',
      start: text(period.start),
      end: text(period.end),
      label: text(period.label),
      previousAnchor: text(period.previousAnchor),
      nextAnchor: nullableText(period.nextAnchor),
    },
    coverage: {
      status: status === 'complete' || status === 'partial' ? status : 'unavailable',
      startsAt: nullableText(coverage.startsAt),
      asOf: text(coverage.asOf),
      periodComplete: coverage.periodComplete === true,
      message: text(coverage.message),
    },
    summary: {
      projects: number(summary.projects),
      kpiMet: number(summary.kpiMet),
      kpiMissed: number(summary.kpiMissed),
      inProgress: number(summary.inProgress),
      unclassified: number(summary.unclassified),
      leads: number(summary.leads),
    },
    groups: {
      leads: Array.isArray(groups.leads) ? groups.leads.map(normalizePerson) : [],
      specialists: Array.isArray(groups.specialists) ? groups.specialists.map(normalizePerson) : [],
    },
  };
}

function normalizeEmployee(value: unknown): TeamReviewEmployee {
  const employee = record(value);
  return {
    id: text(employee.id),
    name: text(employee.name ?? employee.fullName ?? employee.full_name, 'Без имени'),
    email: nullableText(employee.email),
    role: nullableText(employee.role),
    avatarUrl: nullableText(employee.avatarUrl ?? employee.avatar_url),
  };
}

function normalizeReview(value: unknown): TeamReview {
  const review = record(value);
  const employee = review.employee ? normalizeEmployee(review.employee) : null;
  return {
    id: text(review.id),
    reviewDate: text(review.reviewDate ?? review.review_date),
    employee,
    candidateName: nullableText(review.candidateName ?? review.candidate_name),
    reviewer: review.reviewer ? normalizeEmployee(review.reviewer) : null,
    status: text(review.status) === 'scheduled' ? 'scheduled' : 'completed',
    reason: nullableText(review.reason),
    outcomes: nullableText(review.outcomes),
    problems: nullableText(review.problems),
    recommendations: nullableText(review.recommendations),
    createdAt: text(review.createdAt ?? review.created_at),
    updatedAt: text(review.updatedAt ?? review.updated_at),
  };
}

export function normalizeReviews(payload: unknown): TeamReviewsResponse {
  const root = unwrap(payload);
  return {
    reviews: Array.isArray(root.reviews) ? root.reviews.map(normalizeReview) : [],
    employees: Array.isArray(root.employees) ? root.employees.map(normalizeEmployee) : [],
    canManage: root.canManage === true,
    currentUserId: nullableText(root.currentUserId),
  };
}

const TEAM_TALENT_RESERVE_STAGES = new Set<TeamTalentReserveStage>([
  'new',
  'test',
  'interview',
  'reserve',
  'return_later',
  'hired',
  'rejected',
  'archived',
]);

function normalizeTalentReserveEntry(value: unknown): TeamTalentReserveEntry {
  const entry = record(value);
  const rawStage = text(entry.stage) as TeamTalentReserveStage;
  return {
    id: text(entry.id),
    contact: text(entry.contact),
    candidateName: text(entry.candidateName ?? entry.candidate_name, 'Без имени'),
    vacancyDirection: text(entry.vacancyDirection ?? entry.vacancy_direction),
    testAssignment: nullableText(entry.testAssignment ?? entry.test_assignment),
    testResult: nullableText(entry.testResult ?? entry.test_result),
    testSentOn: nullableText(entry.testSentOn ?? entry.test_sent_on),
    interviewOn: nullableText(entry.interviewOn ?? entry.interview_on),
    comment: nullableText(entry.comment),
    revisitOn: nullableText(entry.revisitOn ?? entry.revisit_on),
    revisitNote: nullableText(entry.revisitNote ?? entry.revisit_note),
    stage: TEAM_TALENT_RESERVE_STAGES.has(rawStage) ? rawStage : 'new',
    createdBy: nullableText(entry.createdBy ?? entry.created_by),
    updatedBy: nullableText(entry.updatedBy ?? entry.updated_by),
    createdAt: text(entry.createdAt ?? entry.created_at),
    updatedAt: text(entry.updatedAt ?? entry.updated_at),
  };
}

export function normalizeTalentReserve(payload: unknown): TeamTalentReserveResponse {
  const root = unwrap(payload);
  const summary = record(root.summary);
  return {
    entries: Array.isArray(root.entries) ? root.entries.map(normalizeTalentReserveEntry) : [],
    summary: {
      total: number(summary.total),
      attentionCount: number(summary.attentionCount ?? summary.attention_count),
      activeCount: number(summary.activeCount ?? summary.active_count),
      historyCount: number(summary.historyCount ?? summary.history_count),
    },
    asOf: text(root.asOf ?? root.as_of),
    canManage: root.canManage === true || root.can_manage === true,
  };
}

function normalizeReviewRequestPerson(value: unknown): TeamReviewRequestPerson | null {
  if (!value) return null;
  const person = record(value);
  const id = text(person.id);
  if (!id) return null;
  return {
    id,
    name: text(person.name ?? person.fullName ?? person.full_name, 'Без имени'),
    email: nullableText(person.email),
    avatarUrl: nullableText(person.avatarUrl ?? person.avatar_url),
  };
}

function normalizeReviewRequestProject(value: unknown): TeamReviewRequestProject | null {
  if (!value) return null;
  const project = record(value);
  const id = text(project.id);
  if (!id) return null;
  return {
    id,
    name: text(project.name ?? project.client, 'Без названия'),
  };
}

function normalizeReviewRequest(value: unknown): TeamReviewRequest {
  const request = record(value);
  const rawState = text(request.state);
  const state: TeamReviewRequestState = rawState === 'in_progress'
    || rawState === 'converted'
    || rawState === 'declined'
    ? rawState
    : 'new';
  return {
    id: text(request.id),
    state,
    employee: normalizeReviewRequestPerson(request.employee),
    initiator: normalizeReviewRequestPerson(request.initiator),
    project: normalizeReviewRequestProject(request.project),
    problem: text(request.problem),
    examples: nullableText(request.examples),
    desiredOutcome: text(request.desiredOutcome ?? request.desired_outcome),
    claimedBy: normalizeReviewRequestPerson(request.claimedBy ?? request.claimed_by),
    claimedAt: nullableText(request.claimedAt ?? request.claimed_at),
    linkedReviewId: nullableText(request.linkedReviewId ?? request.linked_review_id),
    decisionNote: nullableText(request.decisionNote ?? request.decision_note),
    createdAt: text(request.createdAt ?? request.created_at),
    updatedAt: text(request.updatedAt ?? request.updated_at),
  };
}

const REVIEW_REQUEST_STATES: readonly TeamReviewRequestState[] = [
  'new',
  'in_progress',
  'converted',
  'declined',
];

export function normalizeReviewRequestSummary(payload: unknown): { newCount: number } {
  const root = unwrap(payload);
  return {
    newCount: Math.max(0, Math.trunc(number(root.newCount ?? root.new_count))),
  };
}

export function normalizeReviewRequests(payload: unknown): TeamReviewRequestsResponse {
  const root = unwrap(payload);
  const rawGroups = Array.isArray(root.groups) ? root.groups : [];
  const grouped = new Map<TeamReviewRequestState, TeamReviewRequest[]>();
  for (const state of REVIEW_REQUEST_STATES) grouped.set(state, []);
  for (const rawGroup of rawGroups) {
    const group = record(rawGroup);
    const state = text(group.state) as TeamReviewRequestState;
    if (!REVIEW_REQUEST_STATES.includes(state) || !Array.isArray(group.requests)) continue;
    grouped.set(state, group.requests.map(normalizeReviewRequest));
  }
  const summary = record(root.summary);
  return {
    groups: REVIEW_REQUEST_STATES.map((state) => ({
      state,
      requests: grouped.get(state) || [],
    })),
    summary: {
      total: number(summary.total),
      newCount: number(summary.newCount ?? summary.new_count),
      inProgressCount: number(summary.inProgressCount ?? summary.in_progress_count),
      convertedCount: number(summary.convertedCount ?? summary.converted_count),
      declinedCount: number(summary.declinedCount ?? summary.declined_count),
    },
    employees: Array.isArray(root.employees)
      ? root.employees.map(normalizeReviewRequestPerson).filter((person): person is TeamReviewRequestPerson => person !== null)
      : [],
    projects: Array.isArray(root.projects)
      ? root.projects.map(normalizeReviewRequestProject).filter((project): project is TeamReviewRequestProject => project !== null)
      : [],
    canManage: root.canManage === true || root.can_manage === true,
  };
}

function normalizeActivityPlanItem(value: unknown): TeamActivityPlanItem {
  const item = record(value);
  const rawStatus = text(item.status);
  const status: TeamActivityPlanStatus = rawStatus === 'completed' || rawStatus === 'cancelled'
    ? rawStatus
    : 'planned';
  const planMonth = text(item.planMonth ?? item.plan_month);
  const plannedDate = nullableText(item.plannedDate ?? item.planned_date);

  return {
    id: text(item.id),
    planMonth: planMonth.length >= 7 ? planMonth.slice(0, 7) : planMonth,
    periodicity: text(item.periodicity),
    activity: text(item.activity),
    format: nullableText(item.format),
    plannedDate,
    plannedTime: plannedDate ? nullableText(item.plannedTime ?? item.planned_time) : null,
    scheduleNote: plannedDate ? null : nullableText(item.scheduleNote ?? item.schedule_note),
    note: nullableText(item.note),
    budgetAmount: nullableNumber(item.budgetAmount ?? item.budget_amount),
    budgetNote: nullableText(item.budgetNote ?? item.budget_note),
    status,
    position: number(item.position),
    createdAt: text(item.createdAt ?? item.created_at),
    updatedAt: text(item.updatedAt ?? item.updated_at),
  };
}

export function normalizeActivityPlan(payload: unknown): TeamActivityPlanResponse {
  const root = unwrap(payload);
  const period = record(root.period);
  const summary = record(root.summary);

  return {
    period: {
      month: text(period.month),
      label: text(period.label),
      previousMonth: text(period.previousMonth ?? period.previous_month),
      nextMonth: text(period.nextMonth ?? period.next_month),
    },
    items: Array.isArray(root.items) ? root.items.map(normalizeActivityPlanItem) : [],
    summary: {
      total: number(summary.total),
      planned: number(summary.planned),
      completed: number(summary.completed),
      cancelled: number(summary.cancelled),
      overdue: number(summary.overdue),
      budgetAmount: number(summary.budgetAmount ?? summary.budget_amount),
      budgetUnspecified: number(summary.budgetUnspecified ?? summary.budget_unspecified),
    },
    asOf: text(root.asOf ?? root.as_of),
    canManage: root.canManage === true || root.can_manage === true,
  };
}

async function accessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Сессия закончилась. Обновите страницу и войдите снова.');
  return session.access_token;
}

export async function teamApiFetch(
  input: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = await accessToken();
  const response = await fetch(input, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = record(payload);
    throw new TeamApiError(
      text(body.error ?? body.message, 'Не удалось загрузить данные. Попробуйте ещё раз.'),
      response.status,
      body,
    );
  }
  return payload;
}

const TEAM_STATISTICS_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

export function teamStatisticsIsoDate(date = new Date()): string {
  return new Date(date.getTime() + TEAM_STATISTICS_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function localIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatRussianDate(value: string): string {
  if (!value) return 'Дата не указана';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}
