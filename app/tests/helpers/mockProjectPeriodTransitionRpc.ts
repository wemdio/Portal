import type { MockSupabaseClient, Row } from './mockSupabase';

function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function dayBefore(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function valueOrProject(
  params: Row,
  project: Row,
  flag: string,
  value: string,
  projectColumn: string,
): unknown {
  return params[flag] === true ? (params[value] ?? null) : (project[projectColumn] ?? null);
}

/**
 * In-memory model of transition_project_period used by route tests.
 *
 * The real function is transactional. This handler only models the successful
 * path; failure/ambiguous-response tests wrap or replace it so partial writes
 * are never produced by the mock itself.
 */
export async function mockTransitionProjectPeriod(
  params: Row,
  db: MockSupabaseClient,
): Promise<{ data: unknown; error?: { message: string; code?: string } }> {
  const projectId = String(params.p_project_id ?? '');
  const newPeriodId = String(params.p_new_period_id ?? '');
  const firstPeriodId = params.p_first_period_id == null
    ? null
    : String(params.p_first_period_id);

  const alreadyCommitted = db.getRows('project_periods').find(
    (row) => row.id === newPeriodId,
  );
  if (alreadyCommitted) {
    if (alreadyCommitted.project_id !== projectId) {
      return {
        data: null,
        error: { message: 'new_period_id_belongs_to_another_project', code: '23505' },
      };
    }
    return { data: { period: alreadyCommitted } };
  }

  const project = db.getRows('projects').find((row) => row.id === projectId);
  if (!project) return { data: null, error: { message: 'project_not_found', code: 'P0002' } };

  const periods = db.getRows('project_periods').filter((row) => row.project_id === projectId);
  const active = periods.find((row) => row.status === 'active') ?? null;
  const expectedCount = Number(params.p_expected_period_count);
  const expectedActiveId = params.p_expected_active_period_id ?? null;
  if (periods.length !== expectedCount || (active?.id ?? null) !== expectedActiveId) {
    return {
      data: null,
      error: { message: 'project_period_state_changed', code: '40001' },
    };
  }

  const periodStart = String(params.p_period_start);
  const priorStart = periods.length === 0
    ? dateOnly(project.launch_date) ?? dateOnly(project.payment_date) ?? dateOnly(project.created_at)
    : dateOnly(active?.period_start);
  if (priorStart && periodStart <= priorStart) {
    return {
      data: null,
      error: { message: 'period_start_must_follow_previous', code: '22023' },
    };
  }

  if (periods.length === 0) {
    if (!firstPeriodId) {
      return {
        data: null,
        error: { message: 'first_period_id_required', code: '22023' },
      };
    }
    await db.from('project_periods').insert({
      id: firstPeriodId,
      project_id: projectId,
      name: 'Period 1',
      status: 'closed',
      period_start: priorStart ?? periodStart,
      period_end: dayBefore(periodStart),
      contacts_obligation: project.contacts_obligation ?? null,
      contacts_done: project.contacts_done ?? null,
      kpi_plan: project.kpi_plan ?? null,
      kpi_fact: project.kpi_fact ?? null,
      deadline: project.deadline ?? null,
      budget: project.budget ?? null,
      margin: project.margin ?? null,
      payment_date: project.payment_date ?? null,
    });
  } else if (active) {
    await db
      .from('project_periods')
      .update({ status: 'closed', period_end: dayBefore(periodStart) })
      .eq('id', active.id);
  }

  const newPeriod = {
    id: newPeriodId,
    project_id: projectId,
    name: `Period ${periods.length + (periods.length === 0 ? 2 : 1)}`,
    status: 'active',
    period_start: periodStart,
    period_end: null,
    contacts_obligation: valueOrProject(
      params,
      project,
      'p_has_contacts_obligation',
      'p_contacts_obligation',
      'contacts_obligation',
    ),
    contacts_done: '0',
    kpi_plan: valueOrProject(params, project, 'p_has_kpi_plan', 'p_kpi_plan', 'kpi_plan'),
    kpi_fact: '0',
    deadline: valueOrProject(params, project, 'p_has_deadline', 'p_deadline', 'deadline'),
    budget: valueOrProject(params, project, 'p_has_budget', 'p_budget', 'budget'),
    margin: valueOrProject(params, project, 'p_has_margin', 'p_margin', 'margin'),
    payment_date: valueOrProject(
      params,
      project,
      'p_has_payment_date',
      'p_payment_date',
      'payment_date',
    ),
  };
  await db.from('project_periods').insert(newPeriod);
  await db
    .from('projects')
    .update({
      contacts_obligation: newPeriod.contacts_obligation,
      contacts_done: '0',
      contacts_done_synced_at: null,
      kpi_plan: newPeriod.kpi_plan,
      kpi_fact: '0',
      deadline: newPeriod.deadline,
      budget: newPeriod.budget,
      margin: newPeriod.margin,
      payment_date: newPeriod.payment_date,
    })
    .eq('id', projectId);

  return { data: { period: newPeriod } };
}
