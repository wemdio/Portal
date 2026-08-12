/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260811_0001_team_talent_reserve.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

function createTableSql(sql: string): string {
  const start = sql.indexOf('create table if not exists public.team_talent_reserve_entries');
  if (start < 0) return '';
  const end = sql.indexOf(');', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 2);
}

function tableIndexes(sql: string): string[] {
  return (sql.match(/create index if not exists [^;]+;/g) ?? [])
    .filter((statement) => statement.includes('on public.team_talent_reserve_entries'));
}

describe('team talent reserve migration', () => {
  it('creates the complete typed schema with server-owned audit columns', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const table = createTableSql(readMigration());

    expect(table).toContain('id uuid primary key default gen_random_uuid()');
    expect(table).toContain('contact text not null');
    expect(table).toContain('candidate_name text not null');
    expect(table).toContain('vacancy_direction text not null');
    expect(table).toContain('test_assignment text');
    expect(table).toContain('test_result text');
    expect(table).toContain('test_sent_on date');
    expect(table).toContain('interview_on date');
    expect(table).toContain('revisit_on date');
    expect(table).toContain('comment text');
    expect(table).toContain('revisit_note text');
    expect(table).toContain("stage text not null default 'new'");
    expect(table).toContain('created_by uuid');
    expect(table).toContain('updated_by uuid');
    expect(table).not.toContain('created_by uuid not null');
    expect(table).not.toContain('updated_by uuid not null');
    expect(table).toContain('created_at timestamptz not null default now()');
    expect(table).toContain('updated_at timestamptz not null default now()');
  });

  it('bounds required meaningful text and nullable optional text', () => {
    const table = createTableSql(readMigration());

    expect(table).toContain('char_length(btrim(contact)) between 1 and 500');
    expect(table).toContain('char_length(btrim(candidate_name)) between 1 and 200');
    expect(table).toContain('char_length(btrim(vacancy_direction)) between 1 and 500');
    expect(table).toContain(
      'test_assignment is null or char_length(test_assignment) <= 5000',
    );
    expect(table).toContain(
      'test_result is null or char_length(test_result) <= 500',
    );
    expect(table).toContain(
      'comment is null or char_length(comment) <= 5000',
    );
    expect(table).toContain(
      'revisit_note is null or char_length(revisit_note) <= 500',
    );
  });

  it('pins the complete stage lifecycle and return-later reminder invariant', () => {
    const table = createTableSql(readMigration());

    expect(table).toContain(
      "stage in ('new', 'test', 'interview', 'reserve', 'return_later', 'hired', 'rejected', 'archived')",
    );
    expect(table).toContain("stage <> 'return_later'");
    expect(table).toContain('revisit_on is not null');
    expect(table).toMatch(
      /(?:nullif\(btrim\(revisit_note\),\s*''\)\s+is\s+not\s+null|revisit_note\s+is\s+not\s+null\s+and\s+char_length\(btrim\(revisit_note\)\)\s+between\s+1\s+and\s+500)/,
    );
  });

  it('preserves entries when creating or updating actors are offboarded', () => {
    const table = createTableSql(readMigration());

    expect(table).toContain(
      'foreign key (created_by) references public.profiles(id) on delete set null',
    );
    expect(table).toContain(
      'foreign key (updated_by) references public.profiles(id) on delete set null',
    );
  });

  it('keeps updated_at automatic through the shared trigger', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'drop trigger if exists trg_team_talent_reserve_entries_updated_at on public.team_talent_reserve_entries',
    );
    expect(sql).toContain(
      'create trigger trg_team_talent_reserve_entries_updated_at before update on public.team_talent_reserve_entries',
    );
    expect(sql).toContain('execute function public.set_updated_at()');
  });

  it('indexes stage ordering and both attention dates', () => {
    const sql = readMigration();
    const indexes = tableIndexes(sql);

    expect(indexes.some((index) =>
      /\(stage, updated_at desc(?:, id)?\)/.test(index),
    )).toBe(true);
    expect(indexes.some((index) => /\brevisit_on\b/.test(index))).toBe(true);
    expect(indexes.some((index) => /\binterview_on\b/.test(index))).toBe(true);
  });

  it('forces RLS and grants the table only to trusted server roles', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'alter table public.team_talent_reserve_entries enable row level security',
    );
    expect(sql).toContain(
      'alter table public.team_talent_reserve_entries force row level security',
    );
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(
        `revoke all on public.team_talent_reserve_entries from ${role}`,
      );
    }
    expect(sql).toContain(
      "if exists (select 1 from pg_roles where rolname = 'readonly') then",
    );
    expect(sql).toContain(
      "execute 'revoke all on public.team_talent_reserve_entries from readonly'",
    );
    expect(sql).not.toContain(
      'revoke all on public.team_talent_reserve_entries from readonly;',
    );
    expect(sql).toContain(
      'grant all on public.team_talent_reserve_entries to service_role',
    );
    expect(sql).toContain(
      'grant all on public.team_talent_reserve_entries to postgres',
    );

    expect(sql).not.toMatch(
      /grant\s+(?:all|select|insert|update|delete)[^;]*\bto\s+(?:anon|authenticated|readonly)\b/,
    );
  });

  it('keeps browser access fail-closed with no table policies', () => {
    const sql = readMigration();

    expect(sql).not.toMatch(
      /create\s+policy\s+[^;]+\s+on\s+public\.team_talent_reserve_entries/,
    );
    expect(sql).not.toContain('using (public.can_access_team())');
    expect(sql).not.toContain('with check (public.can_access_team())');
  });

  it('does not redefine or broaden the canonical private-Team capability', () => {
    const sql = readMigration();

    expect(sql).not.toContain('create or replace function public.can_access_team()');
    expect(sql).not.toMatch(/update\s+public\.profiles\s+set\s+can_access_team_private/);
  });
});
