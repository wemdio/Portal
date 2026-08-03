/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('health-check website enrichment lifecycle', () => {
  it('monitors preparing jobs using their dedicated heartbeat', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), '../services/health-check/main.py'),
      'utf8',
    );

    expect(source).toMatch(
      /JobMonitorSpec\(\s*"website_enrichment_jobs",\s*"[^"]+",\s*\("preparing",\s*"pending",\s*"running"\)/,
    );
    expect(source).toContain('queue_heartbeat_column="preparing_heartbeat_at"');
    expect(source).toContain('f"coalesce(j.{spec.queue_heartbeat_column}, j.created_at)"');
    expect(source).toContain('JOB_STUCK_MINUTES');
    expect(source).toContain('status in ("pending", "queued", "preparing", "planning", "uploading")');
  });

  it('does not treat the permanent HH archive sink as a worker job', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), '../services/health-check/main.py'),
      'utf8',
    );

    expect(source).toContain("extra_predicate=\"j.parser_type <> 'hh_vacancies_autopipeline'\"");
    expect(source).toContain('f" AND ({spec.extra_predicate})"');
  });
});
