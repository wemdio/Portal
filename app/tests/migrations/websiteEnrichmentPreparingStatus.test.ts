/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('website enrichment preparing status migration', () => {
  it('adds the non-claimable preparing status to the jobs constraint', () => {
    const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
    const migrationName = fs
      .readdirSync(migrationsDir)
      .find((name) => name.includes('website_enrichment_preparing_status'));

    expect(migrationName).toBeDefined();

    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toContain('drop constraint if exists website_enrichment_jobs_status_check');
    expect(sql).toMatch(/add column if not exists preparing_heartbeat_at\s+timestamp with time zone/i);
    expect(sql).toMatch(/status\s+in\s*\([^)]*'preparing'[^)]*'pending'[^)]*'running'/i);
    expect(sql).toMatch(/claim_website_enrichment_items[\s\S]*j\.status\s*=\s*'running'/i);
    expect(sql).toContain('get_website_enrichment_queue_counts');
    expect(sql).toMatch(/revoke execute on function public\.get_website_enrichment_queue_counts[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.get_website_enrichment_queue_counts[\s\S]*to service_role/i);
    expect(sql).toMatch(
      /increment_website_enrichment_job_counters[\s\S]*where\s+id\s*=\s*p_job_id\s+and\s+status\s+in\s*\(\s*'pending'\s*,\s*'running'\s*\)/i,
    );
    expect(sql).toMatch(
      /revoke execute on function public\.increment_website_enrichment_job_counters[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.increment_website_enrichment_job_counters[\s\S]*to service_role/i,
    );
  });
});
