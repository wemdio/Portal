/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve(
  __dirname,
  '../../../scripts/db/activateClientReportLargeScoreRollup.js',
);
const exists = fs.existsSync(scriptPath);
const scriptSource = exists ? fs.readFileSync(scriptPath, 'utf8') : '';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const subject = (exists ? require(scriptPath) : {}) as {
  parseCliArgs?: (args: string[]) => {
    mode: 'dry-run' | 'apply';
    action: 'activate' | 'rollback';
    runId: string | null;
  };
  canonicalizeSummary?: (row: Record<string, unknown>) => unknown;
  buildParityWindows?: (input: {
    coverageFromUtc: string;
    coverageToUtc: string;
    asOfUtc: string;
  }) => Array<{ fromUtc: string; toUtc: string; labels: string[] }>;
  assertSummaryParity?: (
    legacy: Record<string, unknown>,
    shadow: Record<string, unknown>,
  ) => void;
  createProgressReporter?: (input: {
    filePath?: string;
    tmpDir?: string;
    pid?: number;
    now?: () => Date;
    appendFileSync: jest.Mock;
    writeLine: jest.Mock;
  }) => (event: Record<string, unknown>) => void;
  PostgresRollupActivationRepository?: new (input: {
    client: { query: jest.Mock };
    clientUserId: string;
    allowedCampaignIds: string[];
    progress?: jest.Mock;
  }) => {
    verifyParity(
      runId: string,
      options?: { readOnly?: boolean },
    ): Promise<unknown>;
    activate(runId: string): Promise<unknown>;
    rollbackOpenParity(): Promise<void>;
    rollback(): Promise<unknown>;
  };
  executeActivation?: (input: {
    mode: 'dry-run' | 'apply';
    action: 'activate' | 'rollback';
    runId: string | null;
    repository: {
      inspect: jest.Mock;
      verifyParity: jest.Mock;
      rollbackOpenParity: jest.Mock;
      activate: jest.Mock;
      rollback: jest.Mock;
    };
  }) => Promise<unknown>;
};

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clientUserId = '33333333-3333-4333-8333-333333333333';

const summaryRow = {
  scored_companies: '100',
  working_score_companies: '30',
  email_found_companies: '20',
  validated_emails: '18',
  submitted_contacts: '10',
  confirmed_contacts: '7',
  legacy_submitted_contacts: '2',
  event_confirmed_contacts: '9',
  event_legacy_submitted_contacts: '2',
  legacy_scored_companies: '5',
  unattributed_confirmed_contacts: '1',
  pipeline_at: '2026-07-31T11:00:00.000Z',
  by_campaign: [
    { campaign_id: 'b', campaign_name: 'B', score_code: 'B', submitted: 2, confirmed: 1 },
    { campaign_id: 'a', campaign_name: 'A', score_code: 'A', submitted: 8, confirmed: 6 },
  ],
};

function repository(overrides: Record<string, jest.Mock> = {}) {
  return {
    inspect: jest.fn().mockResolvedValue({ activeRunId: null }),
    verifyParity: jest.fn().mockResolvedValue({ comparisons: 4 }),
    rollbackOpenParity: jest.fn().mockResolvedValue(undefined),
    activate: jest.fn().mockResolvedValue(runId),
    rollback: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const campaignIds = ['campaign-a', 'campaign-b', 'campaign-c'];

function matrixPayload(params: unknown[]) {
  const windows = JSON.parse(String(params[2])) as Array<{
    key: string;
    labels: string[];
    from_utc: string;
    to_utc: string;
  }>;
  const allowedCampaignIds = params[3] as string[];
  const cells = windows.flatMap((window) => (
    [null, 'A', 'B', 'C'].flatMap((scoreCode) => (
      [null, ...allowedCampaignIds].map((campaignId) => ({
        window_key: window.key,
        labels: window.labels,
        from_utc: window.from_utc,
        to_utc: window.to_utc,
        score_code: scoreCode,
        campaign_id: campaignId,
        matched: true,
      }))
    ))
  ));
  return {
    checked_cells: cells.length,
    source_scans: 1,
    contract_verified: true,
    coverage_verified: true,
    cells,
    mismatches: [],
  };
}

const matrixBounds = {
  from_utc: '2026-05-14T21:00:00.000Z',
  to_utc: '2026-08-13T21:00:00.000Z',
  as_of_utc: '2026-08-13T12:00:00.000Z',
};

function matrixQueryMock(input: {
  statements: string[];
  mutate?: (result: ReturnType<typeof matrixPayload>) => unknown;
  matrixError?: Error;
}) {
  return jest.fn(async (sql: string, params: unknown[] = []) => {
    input.statements.push(sql.replace(/\s+/g, ' ').trim());
    if (/pg_try_advisory_xact_lock/i.test(sql)) {
      return { rows: [{ acquired: true }] };
    }
    if (/min\(bucket\.cohort_day\)/i.test(sql)) {
      return { rows: [matrixBounds] };
    }
    if (/verify_client_report_large_score_rollup_matrix\(/i.test(sql)) {
      if (input.matrixError) throw input.matrixError;
      const result = matrixPayload(params);
      return { rows: [{ result: input.mutate ? input.mutate(result) : result }] };
    }
    return { rows: [] };
  });
}

describe('large-score rollup activation operator', () => {
  it('exists and defaults to a read-only activation preview', () => {
    expect(exists).toBe(true);
    expect(subject.parseCliArgs?.(['--run-id', runId])).toEqual({
      mode: 'dry-run',
      action: 'activate',
      runId,
    });
  });

  it('uses the current owner database connection, never the service REST client', () => {
    expect(scriptSource).toMatch(
      /require\(['"]\.\/ensureDatabase(?:\.js)?['"]\)/,
    );
    expect(scriptSource).toContain('resolveDbUrl');
    expect(scriptSource).not.toContain('supabaseAdmin');
    expect(scriptSource).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(scriptSource).not.toContain('INSTANTLY_DATABASE_URL');
    expect(scriptSource).not.toContain('144.31.54.166');
  });

  it('requires explicit apply and rejects ambiguous activation input', () => {
    expect(subject.parseCliArgs?.(['--apply', '--run-id', runId])).toEqual({
      mode: 'apply',
      action: 'activate',
      runId,
    });
    expect(subject.parseCliArgs?.(['--apply', '--rollback'])).toEqual({
      mode: 'apply',
      action: 'rollback',
      runId: null,
    });
    expect(() => subject.parseCliArgs?.(['--rollback', '--run-id', runId]))
      .toThrow(/rollback|run-id|ambiguous/i);
    expect(() => subject.parseCliArgs?.(['--apply']))
      .toThrow(/run-id|action/i);
  });

  it('persists every real CLI progress event as JSONL as well as stdout', () => {
    const appendFileSync = jest.fn();
    const writeLine = jest.fn();
    const report = subject.createProgressReporter?.({
      filePath: 'activation-progress.jsonl',
      appendFileSync,
      writeLine,
    });
    const event = { stage: 'matrix_started', expected_cells: 96 };

    report?.(event);

    expect(appendFileSync).toHaveBeenCalledWith(
      'activation-progress.jsonl',
      `${JSON.stringify(event)}\n`,
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(writeLine).toHaveBeenCalledWith(
      '[client-report-rollup-activation:progress]',
      JSON.stringify(event),
    );
    expect(scriptSource).toMatch(/progress:\s*createProgressReporter\(\)/);
  });

  it('uses a unique default progress path and private append permissions', () => {
    const appendFileSync = jest.fn();
    const report = subject.createProgressReporter?.({
      tmpDir: 'private-tmp',
      pid: 4321,
      now: () => new Date('2026-08-14T01:02:03.456Z'),
      appendFileSync,
      writeLine: jest.fn(),
    });

    report?.({ stage: 'matrix_started' });

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, _line, options] = appendFileSync.mock.calls[0];
    expect(filePath).toMatch(
      /private-tmp[\\/]client-report-large-score-rollup-activation-4321-2026-08-14T01-02-03-456Z\.jsonl$/,
    );
    expect(options).toEqual({ encoding: 'utf8', flag: 'a', mode: 0o600 });
  });

  it('never mutates in dry-run mode', async () => {
    const target = repository();
    await subject.executeActivation?.({
      mode: 'dry-run',
      action: 'activate',
      runId,
      repository: target,
    });
    expect(target.inspect).toHaveBeenCalledWith(runId);
    expect(target.verifyParity).toHaveBeenCalledWith(runId, {
      readOnly: true,
    });
    expect(target.rollbackOpenParity).toHaveBeenCalledTimes(1);
    expect(target.activate).not.toHaveBeenCalled();
    expect(target.rollback).not.toHaveBeenCalled();
  });

  it('previews rollback without requiring a candidate run id', async () => {
    const target = repository({
      inspect: jest.fn().mockResolvedValue({ activeRunId: runId }),
    });
    await subject.executeActivation?.({
      mode: 'dry-run', action: 'rollback', runId: null, repository: target,
    });
    expect(target.inspect).toHaveBeenCalledWith(null);
    expect(target.verifyParity).not.toHaveBeenCalled();
    expect(target.rollbackOpenParity).not.toHaveBeenCalled();
    expect(target.rollback).not.toHaveBeenCalled();
  });

  it('keeps rollback independent from campaign parity configuration', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const client = {
      query: jest.fn(async (sql: string) => (
        /pg_try_advisory_xact_lock/i.test(sql)
          ? { rows: [{ acquired: true }] }
          : { rows: [{ rollup_run_id: runId }] }
      )),
    };
    const target = new subject.PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds: [],
    });

    await expect(target.rollback()).resolves.toBe(runId);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/deactivate_client_report_large_score_rollup/i),
      [clientUserId],
    );
  });

  it('routes apply through the guarded database functions only', async () => {
    const target = repository();
    await subject.executeActivation?.({
      mode: 'apply', action: 'activate', runId, repository: target,
    });
    expect(target.inspect).toHaveBeenCalledWith(runId);
    expect(target.verifyParity).toHaveBeenCalledWith(runId, {
      readOnly: false,
    });
    expect(target.verifyParity.mock.invocationCallOrder[0]).toBeLessThan(
      target.activate.mock.invocationCallOrder[0],
    );
    expect(target.activate).toHaveBeenCalledWith(runId);
    expect(target.rollback).not.toHaveBeenCalled();

    jest.clearAllMocks();
    await subject.executeActivation?.({
      mode: 'apply', action: 'rollback', runId: null, repository: target,
    });
    expect(target.rollback).toHaveBeenCalledTimes(1);
    expect(target.verifyParity).not.toHaveBeenCalled();
    expect(target.activate).not.toHaveBeenCalled();
  });

  it.each(['mismatch', 'timeout', 'database error'])(
    'never activates when parity verification reports %s',
    async (reason) => {
      const target = repository({
        verifyParity: jest.fn().mockRejectedValue(new Error(reason)),
      });
      await expect(subject.executeActivation?.({
        mode: 'apply', action: 'activate', runId, repository: target,
      })).rejects.toThrow(reason);
      expect(target.activate).not.toHaveBeenCalled();
      expect(target.rollbackOpenParity).toHaveBeenCalledTimes(1);
    },
  );

  it('compares all 13 fields and canonicalizes campaign order/count types', () => {
    expect(typeof subject.canonicalizeSummary).toBe('function');
    expect(typeof subject.assertSummaryParity).toBe('function');
    const reordered = {
      ...summaryRow,
      scored_companies: 100,
      by_campaign: [...summaryRow.by_campaign].reverse().map((row) => ({
        ...row,
        submitted: String(row.submitted),
        confirmed: String(row.confirmed),
      })),
    };
    expect(() => subject.assertSummaryParity?.(summaryRow, reordered))
      .not.toThrow();

    for (const field of Object.keys(summaryRow)) {
      const changed = {
        ...summaryRow,
        [field]: field === 'by_campaign'
          ? [...summaryRow.by_campaign, {
            campaign_id: 'c', campaign_name: 'C', score_code: 'C',
            submitted: 1, confirmed: 1,
          }]
          : field === 'pipeline_at'
            ? '2026-07-31T11:00:01.000Z'
            : String(BigInt(summaryRow[field as keyof typeof summaryRow] as string) + 1n),
      };
      expect(() => subject.assertSummaryParity?.(summaryRow, changed))
        .toThrow(/parity|mismatch/i);
    }
  });

  it('builds and deduplicates every dashboard window while retaining exact full coverage', () => {
    expect(typeof subject.buildParityWindows).toBe('function');
    const windows = subject.buildParityWindows?.({
      coverageFromUtc: '2026-05-14T21:00:00.000Z',
      coverageToUtc: '2026-08-13T21:00:00.000Z',
      asOfUtc: '2026-08-13T12:00:00.000Z',
    }) ?? [];

    expect(windows.map((window) => window.labels).flat()).toEqual(
      expect.arrayContaining([
        '1d', '7d', '30d', 'current_month', 'previous_month', 'full',
      ]),
    );
    expect(windows).toContainEqual(expect.objectContaining({
      fromUtc: '2026-05-14T21:00:00.000Z',
      toUtc: '2026-08-13T21:00:00.000Z',
      labels: expect.arrayContaining(['full']),
    }));
    expect(new Set(windows.map((window) => (
      `${window.fromUtc}/${window.toUtc}`
    ))).size).toBe(windows.length);
    for (const window of windows) {
      expect(new Date(window.fromUtc).getTime()).toBeGreaterThanOrEqual(
        new Date('2026-05-14T21:00:00.000Z').getTime(),
      );
      expect(new Date(window.toUtc).getTime()).toBeLessThanOrEqual(
        new Date('2026-08-13T21:00:00.000Z').getTime(),
      );
    }
  });

  it('deduplicates identical short-coverage windows without losing their labels', () => {
    const windows = subject.buildParityWindows?.({
      coverageFromUtc: '2026-08-11T21:00:00.000Z',
      coverageToUtc: '2026-08-13T21:00:00.000Z',
      asOfUtc: '2026-08-13T12:00:00.000Z',
    }) ?? [];
    expect(new Set(windows.map((window) => (
      `${window.fromUtc}/${window.toUtc}`
    ))).size).toBe(windows.length);
    expect(windows).toContainEqual({
      fromUtc: '2026-08-11T21:00:00.000Z',
      toUtc: '2026-08-13T21:00:00.000Z',
      labels: expect.arrayContaining(['7d', '30d', 'current_month', 'full']),
    });
  });

  it('anchors Moscow month windows to the RR transaction timestamp at an exclusive month boundary', () => {
    const windows = subject.buildParityWindows?.({
      coverageFromUtc: '2026-05-31T21:00:00.000Z',
      coverageToUtc: '2026-07-31T21:00:00.000Z',
      asOfUtc: '2026-07-31T20:59:59.999Z',
    }) ?? [];

    expect(windows).toContainEqual(expect.objectContaining({
      fromUtc: '2026-06-30T21:00:00.000Z',
      toUtc: '2026-07-31T21:00:00.000Z',
      labels: expect.arrayContaining(['current_month']),
    }));
    expect(windows).toContainEqual(expect.objectContaining({
      fromUtc: '2026-05-31T21:00:00.000Z',
      toUtc: '2026-06-30T21:00:00.000Z',
      labels: expect.arrayContaining(['previous_month']),
    }));
  });

  it('omits wall-clock month windows that do not intersect older coverage', () => {
    const windows = subject.buildParityWindows?.({
      coverageFromUtc: '2026-01-31T21:00:00.000Z',
      coverageToUtc: '2026-02-28T21:00:00.000Z',
      asOfUtc: '2026-08-13T12:00:00.000Z',
    }) ?? [];
    const labels = windows.flatMap((window) => window.labels);
    expect(labels).not.toContain('current_month');
    expect(labels).not.toContain('previous_month');
    expect(windows).toContainEqual(expect.objectContaining({
      fromUtc: '2026-01-31T21:00:00.000Z',
      toUtc: '2026-02-28T21:00:00.000Z',
      labels: expect.arrayContaining(['full']),
    }));
  });

  it('verifies the bounded 96-cell matrix with one set-based RPC and activates in the same snapshot', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const progress = jest.fn();
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/pg_try_advisory_xact_lock/i.test(sql)) {
          return { rows: [{ acquired: true }] };
        }
        if (/min\(bucket\.cohort_day\)/i.test(sql)) {
          return { rows: [{
            from_utc: '2026-05-14T21:00:00.000Z',
            to_utc: '2026-08-13T21:00:00.000Z',
            as_of_utc: '2026-08-13T12:00:00.000Z',
          }] };
        }
        if (/activate_client_report_large_score_rollup\(/i.test(sql)) {
          return { rows: [{ rollup_run_id: runId }] };
        }
        if (/verify_client_report_large_score_rollup_matrix\(/i.test(sql)) {
          return { rows: [{ result: matrixPayload(params) }] };
        }
        return { rows: [] };
      }),
    };
    const target = new subject.PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds: campaignIds,
      progress,
    });

    await expect(target.verifyParity(runId)).resolves.toEqual(
      expect.objectContaining({ comparisons: 96 }),
    );
    await target.activate(runId);

    const matrixCalls = statements.filter(({ sql }) => (
      /verify_client_report_large_score_rollup_matrix\(/i.test(sql)
    ));
    expect(matrixCalls).toHaveLength(1);
    expect(statements.some(({ sql }) => (
      /client_report_pipeline_summary(?:_shadow)?\(/i.test(sql)
    ))).toBe(false);
    expect(matrixCalls[0].params.slice(0, 2)).toEqual([clientUserId, runId]);
    expect(matrixCalls[0].params[3]).toEqual(campaignIds);
    const matrixWindows = JSON.parse(String(matrixCalls[0].params[2]));
    expect(matrixWindows).toHaveLength(6);
    expect(matrixWindows).toContainEqual(expect.objectContaining({
      labels: expect.arrayContaining(['full']),
      from_utc: '2026-05-14T21:00:00.000Z',
      to_utc: '2026-08-13T21:00:00.000Z',
    }));
    expect(statements[0].sql).toMatch(/begin.*repeatable read/i);
    expect(statements[0].sql).not.toMatch(/read only/i);
    expect(statements[1]).toEqual({
      sql: expect.stringMatching(/pg_try_advisory_xact_lock/i),
      params: [clientUserId],
    });
    expect(statements).toContainEqual(expect.objectContaining({
      sql: "SET LOCAL statement_timeout = '900s'",
    }));
    expect(statements.at(-1)?.sql).toBe('COMMIT');
    const activationAt = statements.findIndex(({ sql }) => (
      /activate_client_report_large_score_rollup/i.test(sql)
    ));
    const matrixAt = statements.findIndex(({ sql }) => (
      /verify_client_report_large_score_rollup_matrix/i.test(sql)
    ));
    expect(activationAt).toBeGreaterThan(matrixAt);
    expect(activationAt).toBeLessThan(statements.length - 1);
    expect(progress.mock.calls.map(([event]) => event.stage)).toEqual(
      expect.arrayContaining([
        'transaction_started',
        'bounds_loaded',
        'matrix_started',
        'matrix_verified',
        'activation_started',
        'committed',
      ]),
    );
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'committed', run_id: runId,
    }));
  });

  it('uses an explicitly READ ONLY snapshot for dry-run and always rolls it back', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: string[] = [];
    const client = { query: matrixQueryMock({ statements }) };
    const target = new subject.PostgresRollupActivationRepository({
      client, clientUserId, allowedCampaignIds: campaignIds,
    });

    await target.verifyParity(runId, { readOnly: true });
    await target.rollbackOpenParity();

    expect(statements[0]).toMatch(/begin.*repeatable read.*read only/i);
    expect(statements[1]).toMatch(/pg_try_advisory_xact_lock/i);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => (
      /activate_client_report_large_score_rollup/i.test(sql)
    ))).toBe(false);
  });

  it.each([
    ['missing cell', (result: ReturnType<typeof matrixPayload>) => ({
      ...result,
      checked_cells: result.checked_cells - 1,
      cells: result.cells.slice(1),
    })],
    ['duplicate context', (result: ReturnType<typeof matrixPayload>) => ({
      ...result,
      cells: [...result.cells.slice(0, -1), result.cells[0]],
    })],
    ['multiple source scans', (result: ReturnType<typeof matrixPayload>) => ({
      ...result,
      source_scans: 2,
    })],
    ['contract drift', (result: ReturnType<typeof matrixPayload>) => ({
      ...result,
      contract_verified: false,
    })],
    ['coverage drift', (result: ReturnType<typeof matrixPayload>) => ({
      ...result,
      coverage_verified: false,
    })],
  ])('rolls back and rejects an invalid matrix: %s', async (_label, mutate) => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: string[] = [];
    const client = { query: matrixQueryMock({ statements, mutate }) };
    const target = new subject.PostgresRollupActivationRepository({
      client, clientUserId, allowedCampaignIds: campaignIds,
    });

    await expect(target.verifyParity(runId)).rejects.toThrow(
      /matrix|cardinality|context|scan|contract|parity/i,
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => (
      /activate_client_report_large_score_rollup/i.test(sql)
    ))).toBe(false);
  });

  it('reports exact filter context and rolls back on a matrix mismatch', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const progress = jest.fn();
    const statements: string[] = [];
    const client = { query: matrixQueryMock({
      statements,
      mutate: (result) => {
        result.cells[95].matched = false;
        result.mismatches = [result.cells[95]];
        return result;
      },
    }) };
    const target = new subject.PostgresRollupActivationRepository({
      client, clientUserId, allowedCampaignIds: campaignIds, progress,
    });

    await expect(target.verifyParity(runId)).rejects.toThrow(
      /window=.*score=C.*campaign=campaign-c/i,
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'failed',
      run_id: runId,
      context: expect.objectContaining({
        score_code: 'C', campaign_id: 'campaign-c',
      }),
    }));
  });

  it('fails closed when staged progress cannot be recorded', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: string[] = [];
    const progress = jest.fn((event: { stage: string }) => {
      if (event.stage === 'matrix_verified') throw new Error('progress sink failed');
    });
    const client = { query: matrixQueryMock({ statements }) };
    const target = new subject.PostgresRollupActivationRepository({
      client, clientUserId, allowedCampaignIds: campaignIds, progress,
    });

    await expect(target.verifyParity(runId)).rejects.toThrow(/progress sink failed/i);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => (
      /activate_client_report_large_score_rollup/i.test(sql)
    ))).toBe(false);
  });

  it('serializes rollback with activation using the same client advisory lock', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/pg_try_advisory_xact_lock/i.test(sql)) {
          return { rows: [{ acquired: true }] };
        }
        if (/deactivate_client_report_large_score_rollup/i.test(sql)) {
          return { rows: [{ rollup_run_id: runId }] };
        }
        return { rows: [] };
      }),
    };
    const target = new subject.PostgresRollupActivationRepository({
      client, clientUserId, allowedCampaignIds: [],
    });

    await expect(target.rollback()).resolves.toBe(runId);
    expect(statements[0].sql).toMatch(/begin/i);
    expect(statements[1]).toEqual({
      sql: expect.stringMatching(/pg_try_advisory_xact_lock/i),
      params: [clientUserId],
    });
    expect(statements[2].sql).toMatch(/deactivate_client_report_large_score_rollup/i);
    expect(statements.at(-1)?.sql).toBe('COMMIT');
  });

  it('rejects direct activation without a verified open parity transaction', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const client = { query: jest.fn() };
    const target = new subject.PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds: ['campaign-a'],
    });

    await expect(target.activate(runId)).rejects.toThrow(
      /verified|parity|transaction/i,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rolls back with the current stage when the set-based matrix times out', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: string[] = [];
    const client = { query: matrixQueryMock({
      statements,
      matrixError: new Error('canceling statement due to statement timeout'),
    }) };
    const target = new subject.PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds: campaignIds,
    });

    await expect(target.verifyParity(runId)).rejects.toThrow(
      /timeout.*stage=matrix_compare|stage=matrix_compare.*timeout/i,
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
  });
});
