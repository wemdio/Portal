/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('health-check website enrichment lifecycle', () => {
  it('keeps preparing jobs visible and reports them separately from pending jobs', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), '../services/health-check/main.py'),
      'utf8',
    );

    expect(source).toMatch(
      /\("website_enrichment_jobs",\s*"[^"]+",\s*\["preparing",\s*"pending",\s*"running"\]\)/,
    );
    expect(source).toContain("WHERE status IN ('preparing','pending','running')");
    expect(source).toContain('if r["status"] == "preparing":');
    expect(source).toContain('HEALTH_STUCK_PREPARING_MIN');
    expect(source).toContain('coalesce(preparing_heartbeat_at, created_at)');
  });
});
