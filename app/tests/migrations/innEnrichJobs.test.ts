/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('inn_enrich_jobs migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('inn_enrich_jobs'));

  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('creates the jobs table, private bucket, grants, and realtime publication', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/create table if not exists public\.inn_enrich_jobs/i);
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'running'");
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain('source_path');
    expect(sql).toContain('result_path');
    expect(sql).toContain('column_index');
    expect(sql).toMatch(/grant all on table public\.inn_enrich_jobs to service_role/i);
    expect(sql).toMatch(/values \('inn-enrich-exports'/);
    expect(sql).toMatch(/alter publication supabase_realtime add table public\.inn_enrich_jobs/i);
  });
});
