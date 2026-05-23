import fs from 'fs';
import path from 'path';

describe('supabase/instantly-migrations compatibility', () => {
  it('does not assume Supabase service_role exists in local Instantly DB grants', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../../supabase/instantly-migrations/20260520_0001_create_project_period_campaigns.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain("exists (select 1 from pg_roles where rolname = 'service_role')");
    expect(sql).toContain("exists (select 1 from pg_roles where rolname = 'instantly')");
    expect(sql).toContain('grant all on public.project_period_instantly_campaigns to instantly');
  });
});
