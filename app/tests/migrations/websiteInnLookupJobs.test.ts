/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('website INN lookup jobs migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('website_inn_lookup_jobs'));

  it('persists jobs and per-row checkpoints with user isolation', () => {
    expect(migrationName).toBeDefined();
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');

    expect(sql).toMatch(/create table if not exists public\.website_inn_lookup_jobs/i);
    expect(sql).toMatch(/create table if not exists public\.website_inn_lookup_items/i);
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'running'");
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'cancelled'");
    expect(sql).toMatch(/unique[\s\S]*job_id[\s\S]*row_index/i);
    expect(sql).toMatch(/where status in \('pending', 'running'\)/i);
    expect(sql).toMatch(/auth\.uid\(\) = user_id/i);
    expect(sql).toMatch(/grant all on table public\.website_inn_lookup_jobs to service_role/i);
    expect(sql).toMatch(/grant all on table public\.website_inn_lookup_items to service_role/i);
  });
});
