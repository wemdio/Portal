/** @jest-environment node */

import fs from 'fs';
import path from 'path';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260824_0001_project_period_transition_rpc.sql',
);

function sql(): string {
  return fs.readFileSync(MIGRATION, 'utf8').toLowerCase().replace(/\s+/g, ' ');
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
