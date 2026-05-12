/**
 * Unit tests for the migration-lint helper.
 *
 * The lint exists because on self-hosted Supabase the role that runs our
 * SQL migrations is `postgres`, not `supabase_admin`. Default privileges in
 * `public` were configured only for objects created by `supabase_admin`,
 * so any `CREATE TABLE` from a migration lands with empty GRANTs for
 * `service_role`/`authenticated` and our service-role-backed API gets
 * `permission denied for table ...` at runtime (see incident May 2026 with
 * client_support_threads).
 *
 * The lint enforces, across all migration files, the convention:
 *   every `create table public.X` must be matched by at least one
 *   `grant ... on public.X ... to service_role` *somewhere* in the
 *   migrations folder (typically in the same file or a companion
 *   *_grants.sql migration).
 */

import {
  extractCreatedTables,
  findGrantsToServiceRole,
  findMissingServiceRoleGrants,
} from '@/lib/migrationLint';

describe('extractCreatedTables', () => {
  it('returns [] for empty / non-DDL input', () => {
    expect(extractCreatedTables('')).toEqual([]);
    expect(extractCreatedTables('-- a comment only\n')).toEqual([]);
    expect(extractCreatedTables('select 1;')).toEqual([]);
  });

  it('extracts a single public.X table', () => {
    const sql = `
      create table public.foo (
        id uuid primary key
      );
    `;
    expect(extractCreatedTables(sql)).toEqual(['foo']);
  });

  it('handles "if not exists" + indentation + case', () => {
    const sql = `
      CREATE   TABLE   IF NOT EXISTS   public.Bar_Baz_2 (
        id int
      );
    `;
    expect(extractCreatedTables(sql)).toEqual(['Bar_Baz_2']);
  });

  it('extracts multiple tables from one file in source order', () => {
    const sql = `
      create table public.alpha (id int);

      -- some intermezzo
      create table if not exists public.beta (id int);

      create table public.gamma (
        id int
      );
    `;
    expect(extractCreatedTables(sql)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('ignores temp/CTE-like create-table forms in other schemas', () => {
    const sql = `
      create temp table tmp_thing (id int);
      create table other.foo (id int);
      create table public.included (id int);
    `;
    expect(extractCreatedTables(sql)).toEqual(['included']);
  });

  it('ignores tables created inside block-comments', () => {
    const sql = `
      /* create table public.commented_out (id int); */
      create table public.real_one (id int);
    `;
    expect(extractCreatedTables(sql)).toEqual(['real_one']);
  });

  it('ignores tables created in single-line comments', () => {
    const sql = `
      -- create table public.also_commented (id int);
      create table public.kept (id int);
    `;
    expect(extractCreatedTables(sql)).toEqual(['kept']);
  });
});

describe('findGrantsToServiceRole', () => {
  it('detects a plain GRANT ALL', () => {
    const sql = 'GRANT ALL ON public.foo TO service_role;';
    expect(findGrantsToServiceRole(sql)).toEqual(new Set(['foo']));
  });

  it('detects GRANT with "TABLE" keyword and quoted role', () => {
    const sql = 'grant select, insert on table public.bar to "service_role";';
    expect(findGrantsToServiceRole(sql)).toEqual(new Set(['bar']));
  });

  it('detects GRANTs with multiple roles in the list', () => {
    const sql = 'grant all on public.baz to authenticated, service_role, postgres;';
    expect(findGrantsToServiceRole(sql)).toEqual(new Set(['baz']));
  });

  it('does NOT count GRANTs to other roles only', () => {
    const sql = 'grant select on public.foo to authenticated;';
    expect(findGrantsToServiceRole(sql)).toEqual(new Set());
  });

  it('does NOT count GRANTs in other schemas', () => {
    const sql = 'grant all on internal.foo to service_role;';
    expect(findGrantsToServiceRole(sql)).toEqual(new Set());
  });

  it('collects multiple tables', () => {
    const sql = `
      grant all on public.a to service_role;
      grant select on table public.b to service_role;
      grant all on public.c to authenticated; -- ignored
      grant all on public.d to anon, service_role;
    `;
    expect(findGrantsToServiceRole(sql)).toEqual(new Set(['a', 'b', 'd']));
  });

  it('treats wildcard "GRANT ALL ON ALL TABLES IN SCHEMA public" as covering everything', () => {
    const sql = 'grant all on all tables in schema public to service_role;';
    const set = findGrantsToServiceRole(sql);
    expect(set.has('*')).toBe(true);
  });
});

describe('findMissingServiceRoleGrants', () => {
  it('passes when each created table has a matching GRANT in same file', () => {
    const files = [
      {
        name: '20260101_0001_foo.sql',
        sql: `
          create table public.foo (id int);
          grant all on public.foo to service_role;
        `,
      },
    ];
    expect(findMissingServiceRoleGrants(files)).toEqual([]);
  });

  it('passes when GRANT lives in a companion file (cross-file)', () => {
    const files = [
      {
        name: '20260101_0001_create_foo.sql',
        sql: 'create table public.foo (id int);',
      },
      {
        name: '20260101_0002_foo_grants.sql',
        sql: 'grant all on public.foo to service_role;',
      },
    ];
    expect(findMissingServiceRoleGrants(files)).toEqual([]);
  });

  it('passes when wildcard "all tables" GRANT covers everything', () => {
    const files = [
      {
        name: '20260101_0001_create_foo.sql',
        sql: 'create table public.foo (id int);',
      },
      {
        name: '20260101_0002_all_tables.sql',
        sql: 'grant all on all tables in schema public to service_role;',
      },
    ];
    expect(findMissingServiceRoleGrants(files)).toEqual([]);
  });

  it('flags tables without any GRANT to service_role', () => {
    const files = [
      {
        name: '20260101_0001_create_foo.sql',
        sql: `
          create table public.foo (id int);
          create table public.bar (id int);
          grant all on public.foo to service_role; -- bar forgotten
        `,
      },
    ];
    expect(findMissingServiceRoleGrants(files)).toEqual([
      { file: '20260101_0001_create_foo.sql', table: 'bar' },
    ]);
  });

  it('flags duplicates only once per (file, table)', () => {
    const files = [
      {
        name: '20260101_0001_x.sql',
        sql: `
          create table public.foo (id int);
          create table if not exists public.foo (id int); -- idempotent re-decl
        `,
      },
    ];
    const violations = findMissingServiceRoleGrants(files);
    expect(violations).toEqual([
      { file: '20260101_0001_x.sql', table: 'foo' },
    ]);
  });

  it('allowlist suppresses known legacy violations', () => {
    const files = [
      {
        name: '20260101_0001_create_foo.sql',
        sql: 'create table public.foo (id int);',
      },
      {
        name: '20260101_0002_create_bar.sql',
        sql: 'create table public.bar (id int);',
      },
    ];
    const allowlist = new Set([
      '20260101_0001_create_foo.sql::foo',
      '20260101_0002_create_bar.sql::bar',
    ]);
    expect(findMissingServiceRoleGrants(files, { allowlist })).toEqual([]);
  });

  it('allowlist does NOT mask new violations outside the list', () => {
    const files = [
      {
        name: '20260101_0001_legacy.sql',
        sql: 'create table public.legacy_one (id int);',
      },
      {
        name: '20260601_0001_new.sql',
        sql: 'create table public.shiny_new (id int);',
      },
    ];
    const allowlist = new Set(['20260101_0001_legacy.sql::legacy_one']);
    expect(findMissingServiceRoleGrants(files, { allowlist })).toEqual([
      { file: '20260601_0001_new.sql', table: 'shiny_new' },
    ]);
  });
});
