/** @jest-environment node */

import fs from 'fs';
import path from 'path';

const SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../scripts/db/buildClientReportLargeScoreRollup.js',
);
const scriptExists = fs.existsSync(SCRIPT_PATH);
const scriptSource = scriptExists ? fs.readFileSync(SCRIPT_PATH, 'utf8') : '';

type Mode = 'dry-run' | 'apply';

interface RollupJobDay {
  jobId: string;
  moscowDate: string;
}

interface RollupPlan {
  completedJobs: number;
  jobDays: RollupJobDay[];
  sourceWatermark: string;
  uncoveredLegacyRows?: number;
}

interface RollupRun {
  runId: string;
  status: 'building';
  resumed: boolean;
}

interface ScoreBuckets {
  a: number;
  b: number;
  c: number;
  rejected: number;
}

interface RollupVerification {
  runStatus: 'building' | 'ready' | 'active' | 'failed';
  sourceRows: number;
  rollupRows: number;
  sourceBuckets: ScoreBuckets;
  rollupBuckets: ScoreBuckets;
  sourceWatermarkAtStart: string;
  sourceWatermarkAtVerify: string;
  rollupWatermark: string;
  expectedJobDays: number;
  checkpointJobDays: number;
  duplicateBucketKeys: number;
  mismatchedBucketKeys?: number;
}

interface RollupRepository {
  inspectPlan(): Promise<RollupPlan>;
  acquireAdvisoryLock(): Promise<void>;
  releaseAdvisoryLock(): Promise<void>;
  createOrResumeBuildingRun(plan: RollupPlan): Promise<RollupRun>;
  listPendingJobDays(runId: string, plan: RollupPlan): Promise<RollupJobDay[]>;
  rebuildJobDayInTransaction(
    runId: string,
    day: RollupJobDay,
  ): Promise<void>;
  verify(runId: string, plan: RollupPlan): Promise<RollupVerification>;
  markRunReady(runId: string): Promise<void>;
  rollbackOpenVerification?(): Promise<void>;
  activateRun?(runId: string): Promise<void>;
  cutOverRpc?(runId: string): Promise<void>;
}

interface Subject {
  MOSCOW_TIME_ZONE?: string;
  ROLLUP_OBJECTS?: {
    runsTable: string;
    bucketsTable: string;
    checkpointsTable: string;
    rebuildDayFunction: string;
    shadowRpc: string;
  };
  parseCliArgs?: (argv: string[]) => { mode: Mode };
  assertRollupVerification?: (report: RollupVerification) => void;
  PostgresLargeScoreRollupRepository?: new (input: {
    workClient: { query: jest.Mock };
    lockClient: { query: jest.Mock } | null;
    clientUserId: string;
  }) => {
    acquireAdvisoryLock(): Promise<void>;
    releaseAdvisoryLock(): Promise<void>;
    inspectPlan(): Promise<unknown>;
  };
  executeLargeScoreRollupOperator?: (input: {
    mode: Mode;
    repository: RollupRepository;
  }) => Promise<unknown>;
}

// Keep the RED suite readable while the implementation intentionally does not
// exist yet: the first test reports the missing operator, instead of Jest
// aborting during module resolution before the behavioral contract is shown.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const subject = (scriptExists ? require(SCRIPT_PATH) : {}) as Subject;

const PLAN: RollupPlan = {
  completedJobs: 2,
  jobDays: [
    { jobId: '11111111-1111-4111-8111-111111111111', moscowDate: '2026-08-07' },
    { jobId: '11111111-1111-4111-8111-111111111111', moscowDate: '2026-08-08' },
    { jobId: '22222222-2222-4222-8222-222222222222', moscowDate: '2026-08-08' },
  ],
  sourceWatermark: '2026-08-08T19:20:00.000Z',
};

const RUN: RollupRun = {
  runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'building',
  resumed: false,
};

function validVerification(
  overrides: Partial<RollupVerification> = {},
): RollupVerification {
  return {
    runStatus: 'building',
    sourceRows: 6_107_150,
    rollupRows: 6_107_150,
    sourceBuckets: { a: 9_000, b: 8_000, c: 10_729, rejected: 6_079_421 },
    rollupBuckets: { a: 9_000, b: 8_000, c: 10_729, rejected: 6_079_421 },
    sourceWatermarkAtStart: PLAN.sourceWatermark,
    sourceWatermarkAtVerify: PLAN.sourceWatermark,
    rollupWatermark: PLAN.sourceWatermark,
    expectedJobDays: PLAN.jobDays.length,
    checkpointJobDays: PLAN.jobDays.length,
    duplicateBucketKeys: 0,
    mismatchedBucketKeys: 0,
    ...overrides,
  };
}

function makeRepository(input: {
  pending?: RollupJobDay[];
  verification?: RollupVerification;
  run?: RollupRun;
} = {}): jest.Mocked<RollupRepository> {
  return {
    inspectPlan: jest.fn().mockResolvedValue(PLAN),
    acquireAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    releaseAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    createOrResumeBuildingRun: jest.fn().mockResolvedValue(input.run ?? RUN),
    listPendingJobDays: jest.fn().mockResolvedValue(input.pending ?? PLAN.jobDays),
    rebuildJobDayInTransaction: jest.fn().mockResolvedValue(undefined),
    verify: jest.fn().mockResolvedValue(
      input.verification ?? validVerification(),
    ),
    markRunReady: jest.fn().mockResolvedValue(undefined),
    rollbackOpenVerification: jest.fn().mockResolvedValue(undefined),
    activateRun: jest.fn().mockResolvedValue(undefined),
    cutOverRpc: jest.fn().mockResolvedValue(undefined),
  };
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n\r]*/g, '$1');
}

describe('large-score client-report rollup operator', () => {
  it('ships a testable CommonJS operator with pure safety helpers', () => {
    expect(scriptExists).toBe(true);
    if (!scriptExists) return;

    expect(typeof subject.parseCliArgs).toBe('function');
    expect(typeof subject.assertRollupVerification).toBe('function');
    expect(typeof subject.executeLargeScoreRollupOperator).toBe('function');
    expect(subject.MOSCOW_TIME_ZONE).toBe('Europe/Moscow');
    expect(subject.ROLLUP_OBJECTS).toEqual({
      runsTable: 'client_report_large_score_rollup_runs',
      bucketsTable: 'client_report_large_score_rollup_buckets',
      checkpointsTable: 'client_report_large_score_rollup_checkpoints',
      rebuildDayFunction: 'rebuild_client_report_large_score_rollup_day',
      shadowRpc: 'client_report_pipeline_summary_shadow',
    });
  });

  it('is a read-only dry-run by default and rejects ambiguous CLI input', () => {
    if (!scriptExists || !subject.parseCliArgs) return;

    expect(subject.parseCliArgs([])).toEqual({ mode: 'dry-run' });
    expect(subject.parseCliArgs(['--apply'])).toEqual({ mode: 'apply' });
    expect(() => subject.parseCliArgs?.(['--dry-run', '--apply'])).toThrow(
      /mode|dry-run|apply/i,
    );
    expect(() => subject.parseCliArgs?.(['--unknown'])).toThrow(/unknown/i);
    expect(() => subject.parseCliArgs?.(['--apply', '--apply'])).toThrow(
      /duplicate|apply/i,
    );
  });

  it('does not acquire a lock or invoke any write path in dry-run mode', async () => {
    if (!scriptExists || !subject.executeLargeScoreRollupOperator) return;
    const repository = makeRepository();

    await subject.executeLargeScoreRollupOperator({
      mode: 'dry-run',
      repository,
    });

    expect(repository.inspectPlan).toHaveBeenCalledTimes(1);
    expect(repository.acquireAdvisoryLock).not.toHaveBeenCalled();
    expect(repository.createOrResumeBuildingRun).not.toHaveBeenCalled();
    expect(repository.listPendingJobDays).not.toHaveBeenCalled();
    expect(repository.rebuildJobDayInTransaction).not.toHaveBeenCalled();
    expect(repository.verify).not.toHaveBeenCalled();
    expect(repository.markRunReady).not.toHaveBeenCalled();
    expect(repository.activateRun).not.toHaveBeenCalled();
    expect(repository.cutOverRpc).not.toHaveBeenCalled();
  });

  it('serially rebuilds only pending completed job-days and marks the inactive run ready after verification', async () => {
    if (!scriptExists || !subject.executeLargeScoreRollupOperator) return;
    const repository = makeRepository();
    let inFlight = 0;
    let maxInFlight = 0;
    repository.rebuildJobDayInTransaction.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    await subject.executeLargeScoreRollupOperator({
      mode: 'apply',
      repository,
    });

    expect(repository.acquireAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(repository.createOrResumeBuildingRun).toHaveBeenCalledWith(PLAN);
    expect(repository.listPendingJobDays).toHaveBeenCalledWith(RUN.runId, PLAN);
    expect(repository.rebuildJobDayInTransaction.mock.calls).toEqual(
      PLAN.jobDays.map((day) => [RUN.runId, day]),
    );
    expect(maxInFlight).toBe(1);
    expect(repository.verify).toHaveBeenCalledWith(RUN.runId, PLAN);
    expect(repository.markRunReady).toHaveBeenCalledWith(RUN.runId);
    expect(repository.verify.mock.invocationCallOrder[0]).toBeLessThan(
      repository.markRunReady.mock.invocationCallOrder[0],
    );
    expect(repository.activateRun).not.toHaveBeenCalled();
    expect(repository.cutOverRpc).not.toHaveBeenCalled();
    expect(repository.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it('pins a session advisory lock inside an open transaction and releases it on the same client', async () => {
    if (!scriptExists || !subject.PostgresLargeScoreRollupRepository) return;
    const statements: string[] = [];
    const lockClient = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (/pg_try_advisory_lock/i.test(sql)) {
          return { rows: [{ acquired: true }] };
        }
        if (/pg_advisory_unlock/i.test(sql)) {
          return { rows: [{ released: true }] };
        }
        return { rows: [] };
      }),
    };
    const repository = new subject.PostgresLargeScoreRollupRepository({
      workClient: { query: jest.fn() },
      lockClient,
      clientUserId: '33333333-3333-4333-8333-333333333333',
    });

    await repository.acquireAdvisoryLock();
    await repository.releaseAdvisoryLock();

    expect(statements[0]).toBe('BEGIN');
    expect(statements.findIndex((sql) => /pg_try_advisory_lock/i.test(sql)))
      .toBeGreaterThan(0);
    expect(statements.findIndex((sql) => /pg_advisory_unlock/i.test(sql)))
      .toBeGreaterThan(statements.findIndex(
        (sql) => /pg_try_advisory_lock/i.test(sql),
      ));
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('fails plan inspection before the source scan when the required operator index is unavailable', async () => {
    if (!scriptExists || !subject.PostgresLargeScoreRollupRepository) return;
    const statements: string[] = [];
    const workClient = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.includes('idx_large_score_domains_job_scored_at')) {
          return {
            rows: [{
              large_index_ready: false,
              cache_primary_key_ready: true,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const repository = new subject.PostgresLargeScoreRollupRepository({
      workClient,
      lockClient: null,
      clientUserId: '33333333-3333-4333-8333-333333333333',
    });

    await expect(repository.inspectPlan()).rejects.toThrow(
      /required.*index.*missing/i,
    );

    expect(statements).toContain('ROLLBACK');
    expect(statements.some((sql) => sql.includes('source_rows AS ('))).toBe(false);
  });

  it('resumes the same building generation and replays no checkpointed job-day', async () => {
    if (!scriptExists || !subject.executeLargeScoreRollupOperator) return;
    const resumedRun = { ...RUN, resumed: true };
    const repository = makeRepository({
      run: resumedRun,
      pending: [PLAN.jobDays[2]],
    });

    await subject.executeLargeScoreRollupOperator({
      mode: 'apply',
      repository,
    });

    expect(repository.createOrResumeBuildingRun).toHaveBeenCalledWith(PLAN);
    expect(repository.rebuildJobDayInTransaction).toHaveBeenCalledTimes(1);
    expect(repository.rebuildJobDayInTransaction).toHaveBeenCalledWith(
      RUN.runId,
      PLAN.jobDays[2],
    );
    expect(repository.markRunReady).toHaveBeenCalledWith(RUN.runId);
  });

  it('refuses apply before run creation while any legacy row belongs to a non-completed job', async () => {
    if (!scriptExists || !subject.executeLargeScoreRollupOperator) return;
    const repository = makeRepository();
    repository.inspectPlan.mockResolvedValueOnce({
      ...PLAN,
      uncoveredLegacyRows: 1,
    });

    await expect(subject.executeLargeScoreRollupOperator({
      mode: 'apply',
      repository,
    })).rejects.toThrow(/uncovered|non-completed|coverage|legacy/i);

    expect(repository.createOrResumeBuildingRun).not.toHaveBeenCalled();
    expect(repository.rebuildJobDayInTransaction).not.toHaveBeenCalled();
    expect(repository.markRunReady).not.toHaveBeenCalled();
    expect(repository.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['total rows', { rollupRows: 6_107_149 }],
    [
      'score buckets',
      { rollupBuckets: { a: 8_999, b: 8_001, c: 10_729, rejected: 6_079_421 } },
    ],
    ['source drift', { sourceWatermarkAtVerify: '2026-08-08T19:21:00.000Z' }],
    ['rollup watermark', { rollupWatermark: '2026-08-08T19:19:00.000Z' }],
    ['missing checkpoint', { checkpointJobDays: PLAN.jobDays.length - 1 }],
    ['duplicate bucket key', { duplicateBucketKeys: 1 }],
    ['per-key source drift', { mismatchedBucketKeys: 1 }],
    ['premature active status', { runStatus: 'active' as const }],
  ])('fails closed when verification detects %s mismatch', async (
    _label,
    overrides,
  ) => {
    if (
      !scriptExists
      || !subject.executeLargeScoreRollupOperator
      || !subject.assertRollupVerification
    ) return;
    const report = validVerification(overrides);

    expect(() => subject.assertRollupVerification?.(report)).toThrow(
      /mismatch|drift|watermark|checkpoint|duplicate|building|active|verification/i,
    );

    const repository = makeRepository({ verification: report });
    await expect(subject.executeLargeScoreRollupOperator({
      mode: 'apply',
      repository,
    })).rejects.toThrow(
      /mismatch|drift|watermark|checkpoint|duplicate|building|active|verification/i,
    );
    expect(repository.markRunReady).not.toHaveBeenCalled();
    expect(repository.activateRun).not.toHaveBeenCalled();
    expect(repository.cutOverRpc).not.toHaveBeenCalled();
    expect(repository.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it('uses the current Portal DB loader, a session advisory lock and the fixed shadow objects', () => {
    if (!scriptExists) return;
    const executable = stripComments(scriptSource);

    expect(scriptSource).toMatch(
      /require\(['"]\.\/ensureDatabase(?:\.js)?['"]\)/,
    );
    for (const helper of [
      'loadEnvFiles',
      'resolveDbUrl',
      'shouldUseSsl',
      'connectionConfigWithIPv4',
    ]) {
      expect(scriptSource).toContain(helper);
    }
    expect(scriptSource).not.toContain('144.31.54.166');
    expect(scriptSource).not.toContain('INSTANTLY_DATABASE_URL');
    expect(scriptSource).toContain('CLIENT_REPORT_ROLLUP_CLIENT_USER_ID');
    expect(scriptSource).toContain('idx_large_score_domains_job_scored_at');
    expect(scriptSource).toContain('indisvalid');
    expect(scriptSource).toContain('indisready');
    expect(scriptSource).toContain('indislive');
    expect(scriptSource).toContain('mailganer_domain_scores domain primary key');
    expect(scriptSource).toContain('pg_try_advisory_lock');
    expect(scriptSource).toContain('pg_advisory_unlock');
    expect(scriptSource).not.toContain('pg_advisory_xact_lock');
    expect(scriptSource).toContain('Europe/Moscow');
    expect(scriptSource).toContain('rebuild_client_report_large_score_rollup_day');
    expect(scriptSource).toContain('client_report_pipeline_summary_shadow');
    // Джобы гейтятся по статусу: берём и завершённые, и те, что ещё скорятся,
    // иначе строки активного файла 40 дней не попадают в воронку и роняют
    // coverage-guard ежедневной автопересборки (18.08.2026).
    expect(executable).toMatch(
      /status\s+IN\s*\(\s*['"]completed['"]\s*,\s*['"]scoring['"]\s*\)/i,
    );
    expect(executable).toMatch(
      /status\s+NOT\s+IN\s*\(\s*['"]completed['"]\s*,\s*['"]scoring['"]\s*\)/i,
    );
    expect(executable).not.toMatch(/status\s*=\s*['"]completed['"]/i);
  });

  it('contains no activation or current-RPC cutover path', () => {
    if (!scriptExists) return;
    const executable = stripComments(scriptSource);

    expect(executable).not.toMatch(
      /update\s+(?:public\.)?client_report_large_score_rollup_runs[\s\S]{0,500}?status\s*=\s*['"]active['"]/i,
    );
    expect(executable).not.toMatch(
      /create\s+or\s+replace\s+function\s+(?:public\.)?client_report_pipeline_summary\s*\(/i,
    );
    expect(executable).not.toMatch(
      /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?client_report_pipeline_summary\s*\(/i,
    );
  });
});
