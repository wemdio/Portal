/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260729_0001_employee_reviews.sql',
);

describe('employee reviews migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();

  it('denies demo and client accounts at the direct-read RLS boundary', () => {
    expect(sql).toContain("actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')");
    expect(sql).not.toContain("actor.role <> 'client'");
    expect(sql).toContain('coalesce(actor.is_demo, false) = false');
  });

  it('keeps authenticated access read-only', () => {
    expect(sql).toContain('grant select on public.employee_reviews to authenticated');
    expect(sql).not.toContain('grant all on public.employee_reviews to authenticated');
  });

  it('bumps updated_at on every update so API writes can use it as a CAS token', () => {
    expect(sql).toContain(
      'create trigger trg_employee_reviews_updated_at before update on public.employee_reviews',
    );
    expect(sql).toContain('for each row execute function public.set_updated_at()');
  });
});
