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
