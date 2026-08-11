/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260811_0002_team_review_requests.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

function sqlBlock(sql: string, startMarker: string, endMarker = '$$;'): string {
  const start = sql.indexOf(startMarker);
  if (start < 0) return '';
  const end = sql.indexOf(endMarker, start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + endMarker.length);
}

describe('team review requests migration', () => {
  it('creates the review-request schema with bounded, attributable input', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration();
    const table = sqlBlock(
      sql,
      'create table if not exists public.team_review_requests',
      ');',
    );

    expect(table).toContain('id uuid primary key default gen_random_uuid()');
    expect(table).toContain('employee_user_id uuid not null');
    expect(table).toContain('requested_by_user_id uuid not null');
    expect(table).toContain('project_id uuid');
    expect(table).toContain('problem text not null');
    expect(table).toContain('examples text');
    expect(table).toContain('desired_outcome text not null');
    expect(table).toContain("state text not null default 'new'");
    expect(table).toContain('claimed_by uuid');
    expect(table).toContain('claimed_at timestamptz');
    expect(table).toContain('resolved_by uuid');
    expect(table).toContain('resolved_at timestamptz');
    expect(table).toContain('linked_review_id uuid unique');
    expect(table).toContain('decision_note text');
    expect(table).toContain('updated_by uuid');
    expect(table).toContain('created_at timestamptz not null default now()');
    expect(table).toContain('updated_at timestamptz not null default now()');

    expect(table).toContain('references public.profiles(id)');
    expect(table).toContain('references public.projects(id)');
    expect(table).toContain('references public.employee_reviews(id)');
    expect(table).toContain('char_length(btrim(problem)) between 1 and 500');
    expect(table).toContain('examples is null or char_length(examples) <= 5000');
    expect(table).toContain('char_length(btrim(desired_outcome)) between 1 and 1000');
    expect(table).toContain('decision_note is null or char_length(decision_note) <= 1000');
    expect(table).toContain("state in ('new', 'in_progress', 'converted', 'declined')");
  });

  it('pins lifecycle ownership, resolution and review-link invariants in the database', () => {
    const sql = readMigration();
    const table = sqlBlock(
      sql,
      'create table if not exists public.team_review_requests',
      ');',
    );

    expect(table).toMatch(/claimed_by is null[^;]+claimed_at is null/);
    expect(table).toMatch(/resolved_by is null[^;]+resolved_at is null/);
    expect(table).toMatch(/state = 'new'[^;]+claimed_by is null[^;]+resolved_by is null/);
    expect(table).toMatch(/state = 'in_progress'[^;]+claimed_by is not null[^;]+claimed_at is not null/);
    expect(table).toMatch(/state = 'converted'[^;]+linked_review_id is not null/);
    expect(table).toMatch(/state = 'declined'[^;]+linked_review_id is null/);

    const guard = sqlBlock(
      sql,
      'create or replace function public.prevent_team_review_request_terminal_regression()',
    );
    expect(guard).toContain('security definer');
    expect(guard).toContain("set search_path = ''");
    expect(guard).toContain("old.state in ('converted', 'declined')");
    expect(guard).toMatch(/new\.state is distinct from old\.state|new\.state <> old\.state/);
    expect(guard).toContain('raise exception');
    expect(sql).toContain('before update of state on public.team_review_requests');
    expect(sql).toContain('execute function public.prevent_team_review_request_terminal_regression()');
  });

  it('prevents duplicate unresolved requests from the same initiator for one employee', () => {
    const sql = readMigration();

    expect(sql).toContain('create unique index if not exists');
    expect(sql).toMatch(
      /on public\.team_review_requests\s*\(requested_by_user_id, employee_user_id\)\s*where state in \('new', 'in_progress'\)/,
    );
  });

  it('defines a narrow submit capability for private users, leads and directors only', () => {
    const sql = readMigration();
    const predicate = sqlBlock(
      sql,
      'create or replace function public.can_submit_team_review_request()',
    );

    expect(predicate).toContain('returns boolean language sql stable security definer');
    expect(predicate).toContain("set search_path = ''");
    expect(predicate).toContain('public.can_access_team()');
    expect(predicate).toContain('actor.id = auth.uid()');
    expect(predicate).toContain('coalesce(actor.is_demo, false) = false');
    expect(predicate).toContain("actor.role in ('lead', 'director')");
    expect(predicate).not.toMatch(/actor\.role\s*=\s*'(?:manager|admin|technician|sales|marketer|client)'/);
    expect(predicate).not.toMatch(/actor\.role in \([^)]*'(?:manager|admin|technician|sales|marketer|client)'/);
    expect(predicate).not.toMatch(/\b(?:email|full_name|is_hr)\b/);

    expect(sql).toContain(
      'revoke all on function public.can_submit_team_review_request() from public',
    );
    expect(sql).toContain(
      'revoke all on function public.can_submit_team_review_request() from anon',
    );
    expect(sql).toContain(
      'revoke all on function public.can_submit_team_review_request() from authenticated',
    );
    expect(sql).toContain(
      'grant execute on function public.can_submit_team_review_request() to authenticated',
    );
  });

  it('keeps all table access API-only under forced RLS', () => {
    const sql = readMigration();

    expect(sql).toContain('grant all on public.team_review_requests to postgres');
    expect(sql).toContain('grant all on public.team_review_requests to service_role');
    expect(sql).toContain('revoke all on public.team_review_requests from anon');
    expect(sql).toContain('revoke all on public.team_review_requests from authenticated');
    expect(sql).toContain('revoke all on public.team_review_requests from readonly');
    expect(sql).toContain('alter table public.team_review_requests enable row level security');
    expect(sql).toContain('alter table public.team_review_requests force row level security');
    expect(sql).not.toMatch(/grant (?:select|insert|update|delete|all)[^;]+to authenticated/);
    expect(sql).not.toMatch(/create policy [^;]+ to authenticated/);
  });

  it('defines one hardened atomic conversion into the existing review lifecycle', () => {
    const sql = readMigration();
    const convert = sqlBlock(
      sql,
      'create or replace function public.convert_team_review_request(',
    );

    expect(convert).toContain('language plpgsql');
    expect(convert).toContain('security definer');
    expect(convert).toContain("set search_path = ''");
    expect(convert).toContain('auth.uid()');
    expect(convert).toContain('public.can_access_team()');
    expect(convert).toContain('from public.team_review_requests');
    expect(convert).toContain('for update');
    expect(convert).toContain('expected_updated_at');
    expect(convert).toContain("state = 'new'");
    expect(convert).toContain('from public.profiles employee');
    expect(convert).toContain('employee.id = v_request.employee_user_id');
    expect(convert).toContain('coalesce(employee.is_demo, false) = false');
    expect(convert).toMatch(
      /employee\.role in \(\s*'technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead'\s*\)/,
    );
    expect(convert).toContain('insert into public.employee_reviews');
    expect(convert).toContain("'scheduled'");
    expect(convert).toContain('reviewer_user_id');
    expect(convert).toContain('update public.team_review_requests');
    expect(convert).toContain("state = 'converted'");
    expect(convert).toContain('linked_review_id');
    expect(convert).not.toMatch(/\bcommit\b|\brollback\b/);
    expect(convert.indexOf('from public.profiles employee')).toBeGreaterThan(
      convert.indexOf('for update'),
    );
    expect(convert.indexOf('from public.profiles employee')).toBeLessThan(
      convert.indexOf('insert into public.employee_reviews'),
    );

    expect(sql).toMatch(
      /revoke all on function public\.convert_team_review_request\([^;]+from public/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.convert_team_review_request\([^;]+from anon/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.convert_team_review_request\([^;]+from authenticated/,
    );
    expect(sql).toMatch(
      /grant execute on function public\.convert_team_review_request\([^;]+to authenticated/,
    );
  });

  it('keeps timestamps automatic and indexes private inbox ordering', () => {
    const sql = readMigration();

    expect(sql).toContain('before update on public.team_review_requests');
    expect(sql).toContain('execute function public.set_updated_at()');
    expect(sql).toMatch(
      /create index if not exists [^;]+ on public\.team_review_requests\s*\(state, created_at desc, id\)/,
    );
  });
});
