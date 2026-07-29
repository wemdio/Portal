/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260729_0002_team_project_history.sql',
);

describe('team project history migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();

  it('stores the project, cycle, assignee, KPI, date and capture state needed for statistics', () => {
    for (const column of [
      'project_id',
      'period_id',
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
      'captured_at',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('safely converts nullable legacy text dates before storing them as DATE', () => {
    expect(sql).toContain('create or replace function public.team_statistics_safe_date');
    expect(sql).toContain('team_statistics_safe_date(new.launch_date::text)');
    expect(sql).toContain('team_statistics_safe_date(new.deadline::text)');
    expect(sql).toContain('team_statistics_safe_date(p.launch_date::text)');
    expect(sql).toContain('team_statistics_safe_date(p.contract_date::text)');
    expect(sql).toContain('mm.dd.yyyy');
    expect(sql).not.toContain('coalesce(current_period.period_start, new.launch_date');
  });

  it('derives fallback dates in the Moscow business timezone', () => {
    expect(sql).toContain("(new.created_at at time zone 'europe/moscow')::date");
    expect(sql).toContain("(old.created_at at time zone 'europe/moscow')::date");
    expect(sql).toContain("(p.created_at at time zone 'europe/moscow')::date");
    expect(sql).toContain("(clock_timestamp() at time zone 'europe/moscow')::date");
    expect(sql).not.toMatch(/\b(?:new|old|p)\.created_at::date/);
    expect(sql).not.toContain('clock_timestamp()::date');
  });

  it('seeds active cycles from current project KPI and closed cycles from the period', () => {
    expect(sql).toContain("case when pp.id is null or pp.status = 'active' then p.kpi_plan else pp.kpi_plan end");
    expect(sql).toContain("case when pp.id is null or pp.status = 'active' then p.kpi_fact else pp.kpi_fact end");
    expect(sql).toContain("when pp.id is null or pp.status = 'active' then public.team_statistics_safe_date(p.deadline::text)");
  });
  it('freezes the current project KPI when an active period is closed', () => {
    expect(sql).toContain("use_parent_metrics := tg_op = 'update' and old.status = 'active'");
    expect(sql).toContain('case when use_parent_metrics then parent_project.kpi_plan else new.kpi_plan end');
    expect(sql).toContain('case when use_parent_metrics then parent_project.kpi_fact else new.kpi_fact end');
    expect(sql).toContain('when use_parent_metrics then public.team_statistics_safe_date(parent_project.deadline::text)');
  });

  it('captures a tombstone before a project is deleted', () => {
    expect(sql).toContain('create trigger team_project_history_from_project_delete');
    expect(sql).toContain('before delete on public.projects');
    expect(sql).toContain("'project_delete'");
  });

  it('captures relevant changes from both projects and project periods', () => {
    expect(sql).toContain('create trigger team_project_history_from_projects');
    expect(sql).toContain('after insert or update');
    expect(sql).toContain('on public.projects');
    expect(sql).toContain('create trigger team_project_history_from_periods');
    expect(sql).toContain('on public.project_periods');
  });

  it('takes an initial snapshot so the launch month has explicitly partial data', () => {
    expect(sql).toContain("'initial'");
    expect(sql).toContain('from public.projects p');
    expect(sql).toContain('left join public.project_periods pp');
  });

  it('never appends another snapshot for a frozen closed cycle', () => {
    expect(sql).toContain("tg_op = 'update' and old.status = 'closed' and new.status = 'closed'");
    expect(sql).toContain("where pp.project_id = new.id and pp.status = 'active'");
    expect(sql).toContain('if current_period.id is null and exists');
  });

  it('closes a deleted project period without changing its frozen KPI', () => {
    expect(sql).toContain("'period_delete'");
    expect(sql).toContain('create trigger team_project_history_from_period_delete');
    expect(sql).toContain('before delete on public.project_periods');
    expect(sql).toContain('order by h.captured_at desc, h.id desc');
    expect(sql).toContain("frozen.capture_source = 'project_delete'");
  });

  it('allows direct history reads only for known internal roles', () => {
    expect(sql).toContain("actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')");
    expect(sql).not.toContain("actor.role <> 'client'");
  });

  it('is append-only for authenticated users', () => {
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('grant select on public.team_project_history to authenticated');
    expect(sql).not.toContain('grant all on public.team_project_history to authenticated');
  });
});
