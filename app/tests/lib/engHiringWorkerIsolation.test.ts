/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchJsonWithFallback, fetchTextWithFallback } from '@/lib/parsers/atsHttp';
import { runEngHiringParserJob } from '@/lib/parsers/engHiringRunner';

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/parsers/atsHttp', () => ({ fetchJsonWithFallback: jest.fn(), fetchTextWithFallback: jest.fn() }));
jest.mock('@/lib/parsers/companyDomainResolver', () => ({ domainToSiteUrl: jest.fn(), resolveCompanyDomainByName: jest.fn() }));

type ReadResult = { data: unknown; error: { message: string; code?: string } | null; status?: number };
const poolTimeout: ReadResult = { data: null, error: { code: 'PGRST003', message: 'Pool unavailable' } };

function mockHiringRun(statusReads: (ReadResult | Error | string)[], failedWrites: ReadResult[] = []) {
  const job: Record<string, unknown> = { id: 'job-1', status: 'running', config: { sources: ['lever'], companies_limit: 200, enrich: false } };
  const cacheRun = { id: 'cache-1', status: 'running', next_company_index: 130, scanned_companies: 130, cached_vacancies: 1, total_companies: 200 };
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  let statusReadCount = 0;
  let failureWriteCount = 0;
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    let columns = '';
    let patch: Record<string, unknown> | undefined;
    const filters: [string, unknown][] = [];
    const execute = (): ReadResult => {
      if (patch) {
        writes.push({ table, patch });
        if (table === 'parser_jobs') {
          if (patch.status === 'failed') {
            failureWriteCount += 1;
            const failedWrite = failedWrites.shift();
            if (failedWrite) return failedWrite;
          }
          if (filters.every(([key, value]) => job[key] === value)) Object.assign(job, patch);
        } else if (table === 'eng_hiring_cache_runs') Object.assign(cacheRun, patch);
        return { data: null, error: null };
      }
      if (table === 'parser_jobs') {
        if (columns !== 'status') return { data: { ...job }, error: null };
        statusReadCount += 1;
        const next = statusReads.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'object') return next;
        if (next) job.status = next;
        return { data: { status: job.status }, error: null };
      }
      if (table === 'eng_hiring_cache_runs') {
        return { data: columns === 'id' ? null : { ...cacheRun }, error: null };
      }
      if (table === 'eng_hiring_cache' || table === 'eng_hiring_vacancies') return { data: [], error: null };
      throw new Error(`Unexpected table ${table}`);
    };
    const query = {
      select(value: string) { columns = value; return query; },
      update(value: Record<string, unknown>) { patch = value; return query; },
      eq(key: string, value: unknown) { filters.push([key, value]); return query; },
      gte() { return query; },
      in() { return query; },
      order() { return query; },
      limit() { return query; },
      range() { return query; },
      delete() { return query; },
      abortSignal(signal: AbortSignal) { expect(signal).toBeInstanceOf(AbortSignal); return query; },
      single: async () => execute(),
      maybeSingle: async () => execute(),
      then(resolve: (result: ReadResult) => unknown, reject?: (err: unknown) => unknown) {
        return Promise.resolve().then(execute).then(resolve, reject);
      },
    };
    return query;
  });
  jest.mocked(fetchTextWithFallback).mockResolvedValue('name,slug,url\n' + Array.from({ length: 200 }, (_, i) => `Company ${i},company-${i},https://jobs.lever.co/company-${i}`).join('\n'));
  jest.mocked(fetchJsonWithFallback).mockReset().mockResolvedValue([]);
  return { job, cacheRun, writes, statusReadCount: () => statusReadCount, failureWriteCount: () => failureWriteCount };
}

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

  it('has a dedicated ENG hiring worker that distinguishes DB outages from cancellation', async () => {
    const engWorker = readRepoFile('app/worker/engHiring.ts');

    expect(engWorker).toContain('runEngHiringParserJob');
    expect(engWorker).toContain("'eng_hiring'");
    expect(engWorker).not.toContain('runHHParserJob');
    expect(engWorker).not.toContain('runHHArchiveJob');

    // Regression for PGRST003 at the 130/200 checkpoint. Exercise the actual
    // runner offline; all backoff/scan pacing uses fake time, not CI minutes.
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const recovered = mockHiringRun([
        'running', poolTimeout,
        { data: null, error: { message: 'Bad gateway' }, status: 502 },
        new TypeError('fetch failed'), 'running',
      ]);
      const completed = runEngHiringParserJob('job-1');
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchJsonWithFallback).not.toHaveBeenCalled();
      await jest.runAllTimersAsync();
      await completed;
      expect(recovered.job.status).toBe('completed');
      expect(recovered.cacheRun).toMatchObject({ status: 'completed', next_company_index: 200 });
      expect(fetchJsonWithFallback).toHaveBeenCalledTimes(70);
      expect(jest.mocked(fetchJsonWithFallback).mock.calls[0][0]).toContain('company-130');
      expect(recovered.writes.some(({ patch }) => patch.status === 'failed')).toBe(false);

      const stopped = mockHiringRun(['running', poolTimeout, 'cancelled']);
      const cancel = runEngHiringParserJob('job-1');
      await jest.runAllTimersAsync();
      await cancel;
      expect(stopped.job.status).toBe('cancelled');
      expect(stopped.cacheRun.next_company_index).toBe(130);
      expect(fetchJsonWithFallback).not.toHaveBeenCalled();
      expect(stopped.failureWriteCount()).toBe(0);

      const exhausted = mockHiringRun(['running', ...Array<ReadResult>(5).fill(poolTimeout)], [poolTimeout]);
      const failed = runEngHiringParserJob('job-1');
      await jest.runAllTimersAsync();
      await failed;
      expect(exhausted.job).toMatchObject({ status: 'failed', error_message: expect.stringContaining('PGRST003') });
      expect(exhausted.statusReadCount()).toBe(6);
      expect(exhausted.failureWriteCount()).toBe(2);
      expect(exhausted.cacheRun).toMatchObject({ status: 'running', next_company_index: 130 });
      expect(fetchJsonWithFallback).not.toHaveBeenCalled();

      const denied = mockHiringRun([{ data: null, error: { code: '42501', message: 'permission denied' }, status: 403 }]);
      await runEngHiringParserJob('job-1');
      expect(denied.job.status).toBe('failed');
      expect(denied.statusReadCount()).toBe(1);
      expect(fetchJsonWithFallback).not.toHaveBeenCalled();

      const stoppedDuringFailure = mockHiringRun([
        { data: null, error: { code: '42501', message: 'permission denied' }, status: 403 },
      ], [poolTimeout]);
      const stopRace = runEngHiringParserJob('job-1');
      await jest.advanceTimersByTimeAsync(0);
      stoppedDuringFailure.job.status = 'cancelled';
      await jest.runAllTimersAsync();
      await stopRace;
      expect(stoppedDuringFailure.job.status).toBe('cancelled');

      const missing = mockHiringRun([{ data: null, error: null }]);
      await runEngHiringParserJob('job-1');
      expect(missing.job).toMatchObject({ status: 'failed', error_message: expect.stringContaining('missing status') });

      const alreadyStopped = mockHiringRun([]);
      alreadyStopped.job.status = 'cancelled';
      await runEngHiringParserJob('job-1');
      expect(alreadyStopped.writes).toEqual([]);

      // Force a fatal status response, then keep the failure-status write down.
      // The runner must reject so the worker logs the persistence failure.
      mockHiringRun([{ data: null, error: { code: '42501', message: 'permission denied' }, status: 403 }], Array<ReadResult>(5).fill(poolTimeout));
      const rejected = runEngHiringParserJob('job-1').catch((err: Error) => err);
      await jest.runAllTimersAsync();
      expect(await rejected).toEqual(expect.objectContaining({ message: expect.stringContaining('Persist ENG hiring job job-1 failure failed') }));
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
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
