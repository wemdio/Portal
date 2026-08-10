/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const ALINA_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const SERGEY_ID = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260810_0002_private_team_workspace_access.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

function functionSql(sql: string, functionName: string): string {
  const start = sql.indexOf(`create or replace function public.${functionName}()`);
  if (start < 0) return '';
  const end = sql.indexOf('$$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 3);
}

describe('private Team workspace access migration', () => {
  it('adds a fail-closed profile capability and seeds only Alina and Sergey by stable UUID', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration();

    expect(sql).toContain(
      'alter table public.profiles add column if not exists can_access_team_private boolean not null default false',
    );

    const assignments = sql.match(
      /update public\.profiles set can_access_team_private = true where [^;]+;/g,
    ) ?? [];
    expect(assignments).toHaveLength(1);

    const assignment = assignments[0];
    expect(assignment).toContain(`'${ALINA_ID}'::uuid`);
    expect(assignment).toContain(`'${SERGEY_ID}'::uuid`);
    expect(assignment.match(/[0-9a-f]{8}-[0-9a-f-]{27}/g)?.sort()).toEqual(
      [ALINA_ID, SERGEY_ID].sort(),
    );
    expect(assignment).not.toMatch(/\b(?:email|full_name|role|is_hr)\b/);
  });

  it('protects the private-Team capability with the existing profile privilege guard', () => {
    const sql = readMigration();
    const guard = functionSql(sql, 'prevent_profile_privilege_escalation');

    expect(guard).toContain('security definer');
    expect(guard).toContain('new.can_access_team_private is distinct from old.can_access_team_private');
    expect(guard).toContain("auth.role() in ('anon', 'authenticated')");
    expect(guard).toContain('raise exception');
    expect(sql).not.toContain('create trigger prevent_profile_privilege_escalation');
  });

  it('defines one hardened canonical predicate for the exact private workspace capability', () => {
    const sql = readMigration();
    const predicate = functionSql(sql, 'can_access_team');

    expect(predicate).toContain('returns boolean language sql stable security definer');
    expect(predicate).toContain("set search_path = ''");
    expect(predicate).toContain('from public.profiles actor');
    expect(predicate).toContain('actor.id = auth.uid()');
    expect(predicate).toContain('actor.can_access_team_private is true');
    expect(predicate).toContain('coalesce(actor.is_demo, false) = false');
    expect(predicate).toContain(
      "actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')",
    );
    expect(predicate).not.toContain(ALINA_ID);
    expect(predicate).not.toContain(SERGEY_ID);
    expect(predicate).not.toMatch(/\b(?:email|full_name|is_hr)\b/);

    expect(sql).toContain('revoke all on function public.can_access_team() from public');
    expect(sql).toContain('revoke all on function public.can_access_team() from anon');
    expect(sql).toContain('revoke all on function public.can_access_team() from authenticated');
    expect(sql).toContain('grant execute on function public.can_access_team() to authenticated');
  });

  it('delegates both activity viewing and management to the canonical predicate', () => {
    const sql = readMigration();
    const view = functionSql(sql, 'can_view_team_activity_plan');
    const manage = functionSql(sql, 'can_manage_team_activity_plan');

    for (const delegated of [view, manage]) {
      expect(delegated).toContain('returns boolean language sql stable security definer');
      expect(delegated).toContain("set search_path = ''");
      expect(delegated).toContain('select public.can_access_team()');
      expect(delegated).not.toContain('from public.profiles');
      expect(delegated).not.toMatch(/\b(?:is_hr|email|full_name|role)\b/);
    }
  });

  it('preserves the existing RLS policy entry points instead of reopening browser data access', () => {
    const sql = readMigration();

    expect(sql).not.toMatch(/grant\s+(?:all|insert|update|delete)[^;]*\bto authenticated\b/);
    expect(sql).not.toMatch(/create policy [^;]+ for (?:insert|update|delete)\b/);
    expect(sql).not.toContain('using (true)');
  });
});
