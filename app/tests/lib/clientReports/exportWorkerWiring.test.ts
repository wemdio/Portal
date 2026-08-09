/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../../');

describe('client report export worker wiring', () => {
  it('bundles and dispatches a dedicated worker instead of blocking interactive workers', () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.worker'), 'utf8');
    const runner = fs.readFileSync(path.join(repoRoot, 'app/worker/runner.ts'), 'utf8');
    const packageJson = fs.readFileSync(path.join(repoRoot, 'app/package.json'), 'utf8');

    expect(dockerfile).toContain('worker/clientReportExports.ts');
    expect(runner).toContain("case 'clientreportexports':");
    expect(runner).toContain("run('./clientReportExports')");
    expect(packageJson).toContain('worker/clientReportExports.ts');
  });

  it('runs as a small isolated production service with DB and private S3 configuration', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    expect(compose).toContain('worker-client-report-exports:');
    expect(compose).toContain('WORKER_KIND=clientreportexports');
    expect(compose).toContain('SUPABASE_DB_URL=${SUPABASE_DB_URL}');
    expect(compose).toContain('MAIN_S3_BUCKET=${MAIN_S3_BUCKET}');
  });
});
