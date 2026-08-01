/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260801_0001_team_reviews_lifecycle_and_acl.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

describe('team reviews lifecycle and ACL migration', () => {
  it('adds an explicit scheduled/completed lifecycle and backfills existing history', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration();

    expect(sql).toContain('add column if not exists status text');
    expect(sql).toContain('add column if not exists reason text');

    const backfillIndex = sql.indexOf("set status = 'completed'");
    const notNullIndex = sql.indexOf('alter column status set not null');
    expect(backfillIndex).toBeGreaterThan(-1);
    expect(notNullIndex).toBeGreaterThan(backfillIndex);

    expect(sql).toContain("alter column status set default 'scheduled'");
    expect(sql).toContain("status in ('scheduled', 'completed')");
  });

  it('allows empty meeting notes only while a review is scheduled', () => {
    const sql = readMigration();

    expect(sql).toContain('alter column outcomes drop not null');
    expect(sql).toContain(
      'outcomes is null or char_length(btrim(outcomes)) between 1 and 5000',
    );
    expect(sql).toContain(
      "status <> 'completed' or (outcomes is not null and char_length(btrim(outcomes)) between 1 and 5000)",
    );
    expect(sql).toContain(
      "status <> 'scheduled' or (outcomes is null and problems is null and recommendations is null)",
    );
  });

  it('limits an optional planning reason to 500 meaningful characters', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'reason is null or char_length(btrim(reason)) between 1 and 500',
    );
  });

  it('prevents a stale concurrent write from moving completed back to scheduled', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'create or replace function public.prevent_employee_review_status_regression()',
    );
    expect(sql).toContain(
      "if old.status = 'completed' and new.status = 'scheduled' then",
    );
    expect(sql).toContain(
      'before update of status on public.employee_reviews',
    );
    expect(sql).toContain(
      'execute function public.prevent_employee_review_status_regression()',
    );
  });

  it('restricts direct reads to leadership and keeps browser mutations revoked', () => {
    const sql = readMigration();

    expect(sql).toContain("actor.role in ('lead', 'director', 'admin')");
    expect(sql).not.toContain('employee_reviews.employee_user_id = auth.uid()');
    expect(sql).toContain(
      'create policy team_project_history_internal_read on public.team_project_history for select to authenticated using (public.can_access_team())',
    );
    expect(sql).not.toContain('grant all on public.employee_reviews to authenticated');
    expect(sql).not.toContain('grant insert on public.employee_reviews to authenticated');
    expect(sql).not.toContain('grant update on public.employee_reviews to authenticated');
    expect(sql).not.toContain('grant delete on public.employee_reviews to authenticated');
  });
});
