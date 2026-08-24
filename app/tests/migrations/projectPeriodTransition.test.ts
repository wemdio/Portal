/** @jest-environment node */

import fs from 'fs';
import path from 'path';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260824_0001_project_period_transition_rpc.sql',
);
const SAFE_DATE_MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260729_0002_team_project_history.sql',
);

const PRODUCTION_DATE_SCHEMA = {
  projects: {
    launch_date: 'text',
    payment_date: 'text',
    deadline: 'text',
  },
  project_periods: {
    period_start: 'date',
    payment_date: 'date',
    deadline: 'date',
  },
} as const;

const PROJECT_TO_PERIOD_DATE_BOUNDARIES = {
  launch_date: 'period_start',
  payment_date: 'payment_date',
  deadline: 'deadline',
} as const;

function sql(): string {
  return fs.readFileSync(MIGRATION, 'utf8').toLowerCase().replace(/\s+/g, ' ');
}

function safeDateSql(): string {
  return fs.readFileSync(SAFE_DATE_MIGRATION, 'utf8').toLowerCase().replace(/\s+/g, ' ');
}

describe('atomic project period transition migration', () => {
  it('serializes each project and fences the route snapshot before mutation', () => {
    const text = sql();

    expect(text).toContain('create or replace function public.transition_project_period');
    expect(text).toContain('security definer');
    expect(text).toContain('set search_path = pg_catalog, public');
    expect(text).toMatch(/from public\.projects p where p\.id = p_project_id for update/);
    expect(text).toContain('p_expected_period_count');
    expect(text).toContain('p_expected_active_period_id');
    expect(text).toContain('project_period_state_changed');
  });

  it('is idempotent by new period id before checking the expected old state', () => {
    const text = sql();
    const idempotentRead = text.indexOf('where pp.id = p_new_period_id');
    const stateFence = text.indexOf('project_period_state_changed');

    expect(idempotentRead).toBeGreaterThan(-1);
    expect(stateFence).toBeGreaterThan(idempotentRead);
    expect(text).toContain("new_period_id_belongs_to_another_project");
  });

  it('performs snapshot, close, create and project reset without destructive compensation', () => {
    const text = sql();

    expect(text).toContain('insert into public.project_periods');
    expect(text).toContain("set status = 'closed'");
    expect(text).toContain('update public.projects');
    expect(text).not.toContain('delete from public.project_periods');
    expect(text).toContain('return jsonb_build_object');
  });

  it('safely converts production text project dates before using date period fields', () => {
    const text = sql();

    for (const [column, targetColumn] of Object.entries(PROJECT_TO_PERIOD_DATE_BOUNDARIES)) {
      const projectColumn = column as keyof typeof PRODUCTION_DATE_SCHEMA.projects;
      const periodColumn = targetColumn as keyof typeof PRODUCTION_DATE_SCHEMA.project_periods;

      expect(PRODUCTION_DATE_SCHEMA.projects[projectColumn]).toBe('text');
      expect(PRODUCTION_DATE_SCHEMA.project_periods[periodColumn]).toBe('date');
      expect(text).toContain(`v_legacy_${column} date;`);
      expect(text).toContain(
        `v_legacy_${column} := public.team_statistics_safe_date(v_project.${column});`,
      );
    }

    const withoutSafeConversions = text.replace(
      /public\.team_statistics_safe_date\(v_project\.(?:launch_date|payment_date|deadline)\)/g,
      'safe_legacy_date',
    );
    expect(withoutSafeConversions).not.toMatch(
      /v_project\.(?:launch_date|payment_date|deadline)/,
    );

    const parser = safeDateSql();
    expect(parser).toContain("normalized ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    expect(parser).toContain("normalized ~ '^[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}$'");
    expect(parser).toMatch(/exception when others then return null/);
  });

  it('exposes only the atomic RPC to service_role', () => {
    const text = sql();

    expect(text).toMatch(
      /revoke all on function public\.transition_project_period\([^)]+\) from public/,
    );
    expect(text).toMatch(
      /grant execute on function public\.transition_project_period\([^)]+\) to service_role/,
    );
  });
});
