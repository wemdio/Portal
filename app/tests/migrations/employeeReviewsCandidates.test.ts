/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260803_0001_employee_reviews_candidates.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

describe('employee reviews candidates migration', () => {
  it('adds a manual candidate subject and makes the employee link optional', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration();

    expect(sql).toContain('add column if not exists candidate_name text');
    expect(sql).toContain('alter column employee_user_id drop not null');
  });

  it('requires exactly one trimmed review subject with a bounded candidate name', () => {
    const sql = readMigration();

    expect(sql).toContain('add constraint employee_reviews_subject_check');
    expect(sql).toContain(
      'employee_user_id is not null and candidate_name is null',
    );
    expect(sql).toContain(
      'employee_user_id is null and candidate_name is not null',
    );
    expect(sql).toContain('candidate_name = btrim(candidate_name)');
    expect(sql).toContain('char_length(candidate_name) between 1 and 200');
  });

  it('validates the subject constraint before allowing null employee ids', () => {
    const sql = readMigration();
    const addConstraintIndex = sql.indexOf(
      'add constraint employee_reviews_subject_check',
    );
    const validateConstraintIndex = sql.indexOf(
      'validate constraint employee_reviews_subject_check',
    );
    const dropNotNullIndex = sql.indexOf(
      'alter column employee_user_id drop not null',
    );

    expect(sql).toContain('employee_reviews_subject_check check');
    expect(sql).toContain('not valid');
    expect(addConstraintIndex).toBeGreaterThan(-1);
    expect(validateConstraintIndex).toBeGreaterThan(addConstraintIndex);
    expect(dropNotNullIndex).toBeGreaterThan(validateConstraintIndex);
  });

  it('preserves existing rows, foreign keys, RLS, and grants', () => {
    const sql = readMigration();

    expect(sql).not.toMatch(
      /\b(?:update|delete from|insert into|truncate)\s+public\.employee_reviews\b/,
    );
    expect(sql).not.toContain(
      'drop constraint employee_reviews_employee_user_id_fkey',
    );
    expect(sql).not.toContain('disable row level security');
    expect(sql).not.toContain('drop policy');
    expect(sql).not.toMatch(/\b(?:grant|revoke)\b/);
  });
});
