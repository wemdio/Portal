/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('he auto-pipeline migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('he_auto_pipeline'));

  function sql(): string {
    return fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
  }

  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('creates he_auto_pipeline_configs (1:1 к he_projects, капы и last_run_at)', () => {
    expect(sql()).toMatch(/create table if not exists public\.he_auto_pipeline_configs/i);
    expect(sql()).toMatch(/project_id\s+uuid not null unique references public\.he_projects\(id\) on delete cascade/i);
    expect(sql()).toMatch(/enabled\s+boolean not null default true/i);
    expect(sql()).toMatch(/daily_leads_cap\s+integer not null default 50/i);
    expect(sql()).toMatch(/verticals_per_run\s+integer not null default 3/i);
    expect(sql()).toMatch(/last_run_at\s+timestamptz/i);
  });

  it('creates he_auto_pipeline_runs со статусами collecting/appended/no_new/failed', () => {
    expect(sql()).toMatch(/create table if not exists public\.he_auto_pipeline_runs/i);
    expect(sql()).toMatch(/references public\.he_auto_pipeline_configs\(id\) on delete cascade/i);
    for (const status of ['collecting', 'appended', 'no_new', 'failed']) {
      expect(sql()).toContain(`'${status}'`);
    }
    expect(sql()).toMatch(/stats\s+jsonb/i);
    expect(sql()).toMatch(/completed_at\s+timestamptz/i);
  });

  it('RLS включён, гранты service_role на обе таблицы (внутренние ops-таблицы)', () => {
    expect(sql()).toMatch(/alter table public\.he_auto_pipeline_configs\s+enable row level security/i);
    expect(sql()).toMatch(/alter table public\.he_auto_pipeline_runs\s+enable row level security/i);
    expect(sql()).toMatch(/grant all on public\.he_auto_pipeline_configs\s+to\s+service_role/i);
    expect(sql()).toMatch(/grant all on public\.he_auto_pipeline_runs\s+to\s+service_role/i);
  });
});
