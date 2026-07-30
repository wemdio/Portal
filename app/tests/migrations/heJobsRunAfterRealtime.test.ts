/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('he_jobs run_after + realtime migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('he_jobs_run_after_realtime'));

  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('adds he_jobs.run_after (timestamptz, not null, default now())', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/alter table public\.he_jobs/i);
    expect(sql).toMatch(/add column if not exists run_after timestamptz not null default now\(\)/i);
  });

  it('adds a partial (status, run_after) index over pending jobs', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/create index if not exists idx_he_jobs_pending_run_after/i);
    expect(sql).toMatch(/on public\.he_jobs\s*\(status, run_after\)\s*where status = 'pending'/i);
  });

  it('adds he_jobs to supabase_realtime publication (guarded, idempotent)', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    // Guard как в 20260517_0001_create_yandex_direct_parser.sql: без проверки
    // членства повторный прогон миграции падает на duplicate_object.
    expect(sql).toMatch(/pg_publication_tables/i);
    expect(sql).toMatch(/alter publication supabase_realtime add table public\.he_jobs/i);
  });
});
