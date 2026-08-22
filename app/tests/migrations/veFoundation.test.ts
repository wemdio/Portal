/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Vertical Engine v2 foundation migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    '../supabase/migrations/20260820_0001_vertical_engine_v2_foundation.sql',
  );

  function sql(): string {
    return fs.readFileSync(migrationPath, 'utf8');
  }

  it('creates only the isolated v2 project and legacy-link tables', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(sql()).toMatch(/create table if not exists public\.ve_projects/i);
    expect(sql()).toMatch(/create table if not exists public\.ve_legacy_project_links/i);
    expect(sql()).not.toMatch(/create table if not exists public\.ve_jobs/i);
  });

  it('does not alter, reference, or cascade into the ENG-owned he_* schema', () => {
    expect(sql()).not.toMatch(/alter table public\.he_/i);
    expect(sql()).not.toMatch(/references public\.he_/i);
    expect(sql()).not.toMatch(/on delete cascade/i);
  });

  it('keeps both v2 tables sealed behind service-role APIs', () => {
    expect(sql()).toMatch(/alter table public\.ve_projects\s+enable row level security/i);
    expect(sql()).toMatch(
      /alter table public\.ve_legacy_project_links\s+enable row level security/i,
    );
    expect(sql()).toMatch(/grant all on public\.ve_projects\s+to\s+service_role/i);
    expect(sql()).toMatch(
      /grant all on public\.ve_legacy_project_links\s+to\s+service_role/i,
    );
    expect(sql()).not.toMatch(/create policy .*ve_/i);
    expect(sql()).not.toMatch(/grant .* to authenticated/i);
  });

  it('stores explicit verification metadata for every legacy link', () => {
    expect(sql()).toMatch(/legacy_he_project_id\s+uuid primary key/i);
    expect(sql()).toMatch(/verified_by\s+uuid not null/i);
    expect(sql()).toMatch(/verified_at\s+timestamptz not null default now\(\)/i);
    expect(sql()).toMatch(/review_notes\s+text/i);
    expect(sql()).toMatch(/backfill_batch_id\s+text/i);
  });
});
