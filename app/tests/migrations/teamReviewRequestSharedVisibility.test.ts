/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const ANYA_ID = '9e2c53fe-4b86-40b1-b464-757ffe0944dd';
const NIKITA_ID = '416b456b-83b4-48c1-9eeb-9cb6ab88e455';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260813_0001_team_review_request_shared_visibility.sql',
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

describe('team review request shared visibility migration', () => {
  it('adds a closed visibility enum and conservatively keeps every existing request private', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration();

    expect(sql).toContain(
      "alter table public.team_review_requests add column if not exists visibility text not null default 'private'",
    );
    expect(sql).toMatch(
      /check\s*\(\s*visibility\s+in\s*\(\s*'private'\s*,\s*'lead_shared'\s*\)\s*\)/,
    );
    expect(sql).not.toMatch(
      /update\s+public\.team_review_requests\s+set\s+visibility\s*=\s*'lead_shared'/,
    );
  });

  it('makes visibility immutable after insert, including for lifecycle updates', () => {
    const sql = readMigration();
    const guard = sqlBlock(
      sql,
      'create or replace function public.prevent_team_review_request_visibility_change()',
    );

    expect(guard).toContain('returns trigger');
    expect(guard).toContain('security definer');
    expect(guard).toContain("set search_path = ''");
    expect(guard).toContain('new.visibility is distinct from old.visibility');
    expect(guard).toContain(
      'new.requested_by_user_id is distinct from old.requested_by_user_id',
    );
    expect(guard).toContain('raise exception');
    expect(sql).toContain('before update of visibility on public.team_review_requests');
    expect(sql).toContain(
      'before update of requested_by_user_id on public.team_review_requests',
    );
    expect(sql).toContain('execute function public.prevent_team_review_request_visibility_change()');
    expect(sql).toContain(
      'revoke all on function public.prevent_team_review_request_visibility_change() from public',
    );
    expect(sql).toContain(
      'revoke all on function public.prevent_team_review_request_visibility_change() from anon',
    );
    expect(sql).toContain(
      'revoke all on function public.prevent_team_review_request_visibility_change() from authenticated',
    );
  });

  it('adds one guarded private-submit capability and seeds only Anya and Nikita by UUID', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'alter table public.profiles add column if not exists can_submit_team_review_request_private boolean not null default false',
    );
    const assignments = sql.match(
      /update public\.profiles set can_submit_team_review_request_private = true where [^;]+;/g,
    ) ?? [];
    expect(assignments).toHaveLength(1);
    const assignment = assignments[0] ?? '';
    expect(assignment).toContain(`'${ANYA_ID}'::uuid`);
    expect(assignment).toContain(`'${NIKITA_ID}'::uuid`);
    expect(assignment.match(/[0-9a-f]{8}-[0-9a-f-]{27}/g)?.sort()).toEqual(
      [ANYA_ID, NIKITA_ID].sort(),
    );
    expect(assignment).not.toMatch(/\b(?:email|full_name|role|is_hr)\b/);

    const guard = sqlBlock(
      sql,
      'create or replace function public.prevent_profile_privilege_escalation()',
    );
    expect(guard).toContain(
      'new.can_submit_team_review_request_private is distinct from old.can_submit_team_review_request_private',
    );
    expect(guard).toContain("auth.role() in ('anon', 'authenticated')");
    expect(guard).toContain('raise exception');
  });

  it('allows submission only to private Team users, leadership UUIDs, leads and directors', () => {
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
    expect(predicate).toContain('actor.can_submit_team_review_request_private is true');
    expect(predicate).toContain("actor.role in ('lead', 'director')");
    expect(predicate).toMatch(
      /actor\.can_submit_team_review_request_private is true\s+and actor\.role in \('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead'\)/,
    );
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

  it('derives visibility from the immutable requester instead of trusting API input', () => {
    const sql = readMigration();
    const derive = sqlBlock(
      sql,
      'create or replace function public.derive_team_review_request_visibility()',
    );

    expect(derive).toContain('returns trigger');
    expect(derive).toContain('security definer');
    expect(derive).toContain("set search_path = ''");
    expect(derive).toContain('from public.profiles actor');
    expect(derive).toContain('actor.id = new.requested_by_user_id');
    expect(derive).toContain('coalesce(actor.is_demo, false)');
    expect(derive).toContain('if not found or v_is_demo');
    expect(derive).toContain("v_role in ('lead', 'director')");
    expect(derive).toMatch(
      /v_role in \( 'technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead' \) and \(v_can_access_private or v_can_submit_private\)/,
    );
    expect(derive).toContain("new.visibility := 'lead_shared'");
    expect(derive).toContain("new.visibility := 'private'");
    expect(derive).toContain('raise exception');
    expect(sql).toContain('before insert on public.team_review_requests');
    expect(sql).toContain('execute function public.derive_team_review_request_visibility()');
    expect(sql).toContain(
      'revoke all on function public.derive_team_review_request_visibility() from public',
    );
    expect(sql).toContain(
      'revoke all on function public.derive_team_review_request_visibility() from anon',
    );
    expect(sql).toContain(
      'revoke all on function public.derive_team_review_request_visibility() from authenticated',
    );
  });

  it('exposes the shared-read capability to real leads and directors only', () => {
    const sql = readMigration();
    const predicate = sqlBlock(
      sql,
      'create or replace function public.can_view_team_review_requests_shared()',
    );

    expect(predicate).toContain('returns boolean language sql stable security definer');
    expect(predicate).toContain("set search_path = ''");
    expect(predicate).toContain('actor.id = auth.uid()');
    expect(predicate).toContain('coalesce(actor.is_demo, false) = false');
    expect(predicate).toContain("actor.role in ('lead', 'director')");
    expect(predicate).not.toContain('public.can_access_team()');
    expect(predicate).not.toContain('can_submit_team_review_request_private');
    expect(predicate).not.toMatch(/\b(?:email|full_name|is_hr)\b/);

    expect(sql).toContain(
      'revoke all on function public.can_view_team_review_requests_shared() from public',
    );
    expect(sql).toContain(
      'revoke all on function public.can_view_team_review_requests_shared() from anon',
    );
    expect(sql).toContain(
      'revoke all on function public.can_view_team_review_requests_shared() from authenticated',
    );
    expect(sql).toContain(
      'grant execute on function public.can_view_team_review_requests_shared() to authenticated',
    );
  });

  it('keeps storage API-only and indexes the filtered shared queue', () => {
    const sql = readMigration();

    expect(sql).toMatch(
      /create index if not exists [^;]+ on public\.team_review_requests\s*\(visibility, state, created_at desc, id\)/,
    );
    expect(sql).toContain('revoke all on public.team_review_requests from authenticated');
    expect(sql).toContain('alter table public.team_review_requests force row level security');
    expect(sql).not.toMatch(/grant (?:select|insert|update|delete|all)[^;]+to authenticated/);
    expect(sql).not.toMatch(/create policy [^;]+ to authenticated/);
  });
});
