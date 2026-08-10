/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const HR_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260808_0001_team_activity_plan.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

function createTableSql(sql: string): string {
  const start = sql.indexOf('create table if not exists public.team_activity_plan_items');
  if (start < 0) return '';
  const end = sql.indexOf(');', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 2);
}

describe('team activity plan migration', () => {
  it('adds an explicit is_hr capability and seeds only the approved HR profile', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = readMigration();

    expect(sql).toContain(
      'alter table public.profiles add column if not exists is_hr boolean not null default false',
    );

    const trueAssignments = sql.match(
      /update public\.profiles set is_hr = true where [^;]+;/g,
    ) ?? [];
    expect(trueAssignments).toHaveLength(1);
    expect(trueAssignments[0]).toContain(`id = '${HR_ID}'::uuid`);
    expect(trueAssignments[0]).not.toMatch(/\b(?:email|role|full_name)\b/);
    expect(trueAssignments[0]).not.toContain(' or ');
  });

  it('defines HR access from the authoritative capability and an explicit internal role set', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'create or replace function public.can_manage_team_activity_plan()',
    );
    expect(sql).toContain('returns boolean language sql stable security definer');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain('actor.id = auth.uid()');
    expect(sql).toContain('actor.is_hr is true');
    expect(sql).toContain('coalesce(actor.is_demo, false) = false');
    expect(sql).toContain(
      "actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')",
    );
    expect(sql).not.toMatch(/actor\.role\s*=\s*'client'/);
    expect(sql).toContain(
      'revoke all on function public.can_manage_team_activity_plan() from public',
    );
    expect(sql).toContain(
      'revoke all on function public.can_manage_team_activity_plan() from anon',
    );
    expect(sql).toContain(
      'revoke all on function public.can_manage_team_activity_plan() from authenticated',
    );
    expect(sql).toContain(
      'grant execute on function public.can_manage_team_activity_plan() to authenticated',
    );
  });

  it('extends the shared profile privilege guard instead of adding a second trigger', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'create or replace function public.prevent_profile_privilege_escalation()',
    );
    expect(sql).toContain('new.is_hr is distinct from old.is_hr');
    expect(sql).toContain("auth.role() in ('anon', 'authenticated')");
    expect(sql).toContain('raise exception');
    expect(sql).not.toContain('prevent_profile_is_hr_self_assignment');
    expect(sql).not.toContain('profiles_prevent_is_hr_self_assignment');
    expect(sql).not.toContain('create trigger prevent_profile_privilege_escalation');
  });

  it('creates the monthly activity plan schema with bounded content and ordering', () => {
    const sql = readMigration();
    const table = createTableSql(sql);

    expect(table).toContain('id uuid primary key default gen_random_uuid()');
    expect(table).toContain('plan_month date not null');
    expect(table).toContain('periodicity text not null');
    expect(table).toContain('activity text not null');
    expect(table).toContain('format text');
    expect(table).toContain('planned_date date');
    expect(table).toContain('planned_time time without time zone');
    expect(table).toContain('schedule_note text');
    expect(table).toContain('note text');
    expect(table).toContain('budget_amount numeric(12, 2)');
    expect(table).toContain('budget_note text');
    expect(table).toContain("status text not null default 'planned'");
    expect(table).toContain('position integer not null default 0');
    expect(table).toContain('created_by uuid');
    expect(table).not.toContain('created_by uuid not null');
    expect(table).toContain('created_at timestamptz not null default now()');
    expect(table).toContain('updated_at timestamptz not null default now()');

    expect(table).toContain("status in ('planned', 'completed', 'cancelled')");
    expect(table).toContain('char_length(btrim(periodicity)) between 1 and 100');
    expect(table).toContain('char_length(btrim(activity)) between 1 and 500');
    expect(table).toContain('schedule_note is null or char_length(btrim(schedule_note)) between 1 and 500');
    expect(table).toContain('note is null or char_length(btrim(note)) between 1 and 5000');
    expect(table).toContain('budget_amount is null or budget_amount >= 0');
    expect(table).toContain('budget_note is null or char_length(btrim(budget_note)) between 1 and 500');
    expect(table).toContain('position >= 0');
    expect(table).toContain('references public.profiles(id)');
  });

  it('preserves activity history when the creating HR profile is offboarded', () => {
    const table = createTableSql(readMigration());

    expect(table).toContain('created_by uuid');
    expect(table).not.toContain('created_by uuid not null');
    expect(table).toContain('foreign key (created_by) references public.profiles(id) on delete set null');
  });

  it('enforces one unambiguous scheduling mode in the database', () => {
    const table = createTableSql(readMigration());

    expect(table).toContain(
      'constraint team_activity_plan_items_time_requires_date_check check (planned_time is null or planned_date is not null)',
    );
    expect(table).toContain(
      'constraint team_activity_plan_items_date_schedule_exclusive_check check (planned_date is null or schedule_note is null)',
    );
  });

  it('stores planMonth as the first day while allowing plannedDate outside that month', () => {
    const sql = readMigration();
    const table = createTableSql(sql);

    expect(table).toContain(
      "plan_month = date_trunc('month', plan_month)::date",
    );
    expect(table).not.toContain("date_trunc('month', planned_date");
    expect(table).not.toMatch(/planned_date\s*(?:>=|<=|between)\s*plan_month/);
    expect(table).not.toMatch(/plan_month\s*(?:>=|<=)\s*planned_date/);
  });

  it('keeps updated_at automatic and indexes the month-first display order', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'create index if not exists idx_team_activity_plan_items_month_position',
    );
    expect(sql).toContain(
      'on public.team_activity_plan_items(plan_month, position',
    );
    expect(sql).toContain(
      'drop trigger if exists trg_team_activity_plan_items_updated_at on public.team_activity_plan_items',
    );
    expect(sql).toContain(
      'create trigger trg_team_activity_plan_items_updated_at before update on public.team_activity_plan_items',
    );
    expect(sql).toContain('execute function public.set_updated_at()');
  });

  it('forces RLS and exposes direct reads only through the HR predicate', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'alter table public.team_activity_plan_items enable row level security',
    );
    expect(sql).toContain(
      'alter table public.team_activity_plan_items force row level security',
    );
    expect(sql).toContain(
      'revoke all on public.team_activity_plan_items from anon',
    );
    expect(sql).toContain(
      'revoke all on public.team_activity_plan_items from authenticated',
    );
    expect(sql).toContain(
      'grant select on public.team_activity_plan_items to authenticated',
    );
    expect(sql).toContain(
      'grant all on public.team_activity_plan_items to service_role',
    );
    expect(sql).toContain(
      'revoke all on public.team_activity_plan_items from readonly',
    );
    expect(sql).not.toContain(
      'grant insert on public.team_activity_plan_items to authenticated',
    );
    expect(sql).not.toContain(
      'grant update on public.team_activity_plan_items to authenticated',
    );
    expect(sql).not.toContain(
      'grant delete on public.team_activity_plan_items to authenticated',
    );

    expect(sql).toContain(
      'create policy team_activity_plan_items_hr_select on public.team_activity_plan_items for select to authenticated using (public.can_manage_team_activity_plan())',
    );
  });

  it('keeps browser writes fail-closed even if a future migration restores a write grant', () => {
    const sql = readMigration();

    expect(sql).not.toMatch(/create policy [^;]+ for insert\b/);
    expect(sql).not.toMatch(/create policy [^;]+ for update\b/);
    expect(sql).not.toMatch(/create policy [^;]+ for delete\b/);
    expect(sql).toContain('drop policy if exists team_activity_plan_items_hr_insert');
    expect(sql).toContain('drop policy if exists team_activity_plan_items_hr_update');
    expect(sql).toContain('drop policy if exists team_activity_plan_items_hr_delete');
  });
});
