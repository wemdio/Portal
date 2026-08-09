/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260810_0001_team_activity_plan_admin_access.sql',
);
const originalMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260808_0001_team_activity_plan.sql',
);

function readMigration(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

describe('team activity plan admin access migration', () => {
  it('gives non-demo admins read-only access while preserving HR-only management', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration(migrationPath);
    const originalSql = readMigration(originalMigrationPath);

    expect(sql).toContain(
      'create or replace function public.can_view_team_activity_plan()',
    );
    expect(sql).toContain('returns boolean language sql stable security definer');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain('actor.id = auth.uid()');
    expect(sql).toContain(
      "coalesce(actor.is_demo, false) = false and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead') and ( actor.role = 'admin' or actor.is_hr is true )",
    );
    expect(sql).not.toMatch(/actor\.role\s*=\s*'client'/);
    expect(sql).toContain(
      'revoke all on function public.can_view_team_activity_plan() from public',
    );
    expect(sql).toContain(
      'revoke all on function public.can_view_team_activity_plan() from anon',
    );
    expect(sql).toContain(
      'revoke all on function public.can_view_team_activity_plan() from authenticated',
    );
    expect(sql).toContain(
      'grant execute on function public.can_view_team_activity_plan() to authenticated',
    );
    expect(sql).toContain(
      'drop policy if exists team_activity_plan_items_hr_select on public.team_activity_plan_items',
    );
    expect(sql).toContain(
      'create policy team_activity_plan_items_hr_select on public.team_activity_plan_items for select to authenticated using (public.can_view_team_activity_plan())',
    );
    expect(sql).not.toContain(
      'using (public.can_manage_team_activity_plan())',
    );

    // The forward migration must not broaden the existing write capability.
    expect(sql).not.toContain(
      'create or replace function public.can_manage_team_activity_plan()',
    );
    expect(originalSql).toContain(
      "actor.is_hr is true and coalesce(actor.is_demo, false) = false and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')",
    );
  });
});
