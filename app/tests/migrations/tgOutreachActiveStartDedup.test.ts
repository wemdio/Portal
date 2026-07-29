/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('TG Outreach active start job dedup migration', () => {
  it('completes duplicates and enforces one active start per campaign', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      '../supabase/migrations/20260729_0001_tg_outreach_active_start_job_dedup.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /lock table public\.tg_outreach_jobs in share row exclusive mode/i,
    );
    expect(sql).toMatch(
      /row_number\(\)\s+over\s*\(\s*partition by campaign_id[\s\S]*status = 'running'/i,
    );
    expect(sql).toMatch(
      /update public\.tg_outreach_jobs[\s\S]*status = 'completed'[\s\S]*duplicate_rank > 1/i,
    );
    expect(sql).toMatch(
      /create unique index[\s\S]*on public\.tg_outreach_jobs \(campaign_id\)[\s\S]*action = 'start'[\s\S]*status in \('pending', 'running'\)/i,
    );
  });
});
