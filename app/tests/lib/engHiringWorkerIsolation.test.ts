/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('ENG hiring worker isolation', () => {
  it('keeps ENG hiring jobs out of the HH worker', () => {
    const hhWorker = readRepoFile('app/worker/hh.ts');

    expect(hhWorker).not.toContain('engHiringRunner');
    expect(hhWorker).not.toContain('runEngHiringParserJob');
    expect(hhWorker).not.toContain("parser_type', 'eng_hiring");
    expect(hhWorker).not.toContain('"parser_type", "eng_hiring');
  });

  it('has a dedicated ENG hiring worker entrypoint', () => {
    const engWorker = readRepoFile('app/worker/engHiring.ts');

    expect(engWorker).toContain('runEngHiringParserJob');
    expect(engWorker).toContain("'eng_hiring'");
    expect(engWorker).not.toContain('runHHParserJob');
    expect(engWorker).not.toContain('runHHArchiveJob');
  });

  it('routes WORKER_KIND=enghiring to the dedicated worker bundle', () => {
    const runner = readRepoFile('app/worker/runner.ts');

    expect(runner).toContain("case 'enghiring'");
    expect(runner).toContain("case 'eng-hiring'");
    expect(runner).toContain("run('./engHiring')");
  });

  it('bundles the ENG hiring worker in local and Docker worker builds', () => {
    const packageJson = readRepoFile('app/package.json');
    const dockerfile = readRepoFile('Dockerfile.worker');

    expect(packageJson).toContain('worker/engHiring.ts');
    expect(dockerfile).toContain('worker/engHiring.ts');
  });

  it('deploys ENG hiring through its own prod compose service', () => {
    const compose = readRepoFile('docker-compose.prod.yml');
    const scheduledDeploy = readRepoFile('.semaphore/scheduled-deploy.yml');
    const deployTargets = readRepoFile('.semaphore/select-deploy-targets.sh');
    const drainWorker = readRepoFile('drain-worker.sh');

    expect(compose).toContain('worker-eng-hiring:');
    expect(compose).toContain('container_name: portal-worker-eng-hiring');
    expect(compose).toContain('WORKER_KIND=enghiring');
    expect(scheduledDeploy).toContain('. .semaphore/select-deploy-targets.sh');
    expect(scheduledDeploy).toContain("WORKER_TARGETS='${WORKER_SERVICES}'");
    expect(deployTargets).toContain('worker-eng-hiring');
    expect(drainWorker).toContain('portal-worker-eng-hiring');
  });

  it('indexes ENG hiring cache for source, country, and recency filtering', () => {
    const migrationDir = path.join(repoRoot, 'supabase', 'migrations');
    const migrations = fs.readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readRepoFile(path.join('supabase', 'migrations', name)).replace(/\s+/g, ' '))
      .join('\n');

    expect(migrations).toContain('idx_eng_hiring_cache_source_country_published');
    expect(migrations).toContain('on public.eng_hiring_cache(source, country_code, published_at desc)');
  });

  it('allows newly supported ENG hiring ATS sources in database constraints', () => {
    const migrationDir = path.join(repoRoot, 'supabase', 'migrations');
    const migrations = fs.readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readRepoFile(path.join('supabase', 'migrations', name)).replace(/\s+/g, ' '))
      .join('\n');

    expect(migrations).toContain("'breezy'");
    expect(migrations).toContain("'workday'");
    expect(migrations).toContain('eng_hiring_cache_source_check');
    expect(migrations).toContain('eng_hiring_cache_runs_source_check');
    expect(migrations).toContain('eng_hiring_vacancies_source_check');
  });
});
