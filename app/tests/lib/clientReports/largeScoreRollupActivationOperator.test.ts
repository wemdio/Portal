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
  PostgresRollupActivationRepository?: new (input: {
    client: { query: jest.Mock };
    clientUserId: string;
    allowedCampaignIds: string[];
  }) => {
    verifyParity(runId: string): Promise<unknown>;
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

  it('never mutates in dry-run mode', async () => {
    const target = repository();
    await subject.executeActivation?.({
      mode: 'dry-run',
      action: 'activate',
      runId,
      repository: target,
    });
    expect(target.inspect).toHaveBeenCalledWith(runId);
    expect(target.verifyParity).toHaveBeenCalledWith(runId);
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
      query: jest.fn().mockResolvedValue({ rows: [{ rollup_run_id: runId }] }),
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
    expect(target.verifyParity).toHaveBeenCalledWith(runId);
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

  it('verifies a bounded tenant-scoped score/campaign matrix with identical filters', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
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
        if (/client_report_pipeline_summary(?:_shadow)?\(/i.test(sql)) {
          return { rows: [summaryRow] };
        }
        return { rows: [] };
      }),
    };
    const target = new subject.PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds: ['campaign-a', 'campaign-b'],
    });

    await target.verifyParity(runId);
    await target.activate(runId);

    const legacy = statements.filter(({ sql }) => (
      /public\.client_report_pipeline_summary\(/i.test(sql)
      && !/_shadow/i.test(sql)
    ));
    const shadow = statements.filter(({ sql }) => /_summary_shadow\(/i.test(sql));
    // 1d, 7d, 30d, current/previous Moscow month and full coverage
    // x 4 score states (all/A/B/C) x aggregate + each allowlisted campaign.
    expect(legacy).toHaveLength(72);
    expect(shadow).toHaveLength(72);
    for (let index = 0; index < legacy.length; index += 1) {
      expect(legacy[index].params.slice(0, 4)).toEqual([
        clientUserId,
        expect.stringMatching(/^2026-(05-14|06-30|07-(14|31)|08-(06|12))T21:00:00\.000Z$/),
        expect.stringMatching(/^2026-(07-31|08-13)T21:00:00\.000Z$/),
        ['campaign-a', 'campaign-b'],
      ]);
      expect([null, 'A', 'B', 'C']).toContain(legacy[index].params[4]);
      expect([null, 'campaign-a', 'campaign-b']).toContain(
        legacy[index].params[5],
      );
      expect(shadow[index].params).toEqual([
        clientUserId,
        runId,
        ...legacy[index].params.slice(1),
      ]);
    }
    expect(statements[0].sql).toMatch(/begin.*repeatable read/i);
    expect(statements[0].sql).not.toMatch(/read only/i);
    expect(statements).toContainEqual(expect.objectContaining({
      sql: "SET LOCAL statement_timeout = '120s'",
    }));
    expect(statements.at(-1)?.sql).toBe('COMMIT');
    expect(legacy).toContainEqual(expect.objectContaining({
      params: [
        clientUserId,
        '2026-05-14T21:00:00.000Z',
        '2026-08-13T21:00:00.000Z',
        ['campaign-a', 'campaign-b'],
        null,
        null,
      ],
    }));
    const activationAt = statements.findIndex(({ sql }) => (
      /activate_client_report_large_score_rollup/i.test(sql)
    ));
    const lastShadowAt = statements.map(({ sql }) => sql)
      .lastIndexOf(shadow.at(-1)?.sql ?? '');
    expect(activationAt).toBeGreaterThan(lastShadowAt);
    expect(activationAt).toBeLessThan(statements.length - 1);
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

  it('rolls back the read transaction when a parity query times out', async () => {
    if (!subject.PostgresRollupActivationRepository) return;
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        statements.push(normalized);
        if (/min\(bucket\.cohort_day\)/i.test(sql)) {
          return { rows: [{
            from_utc: '2026-06-30T21:00:00.000Z',
            to_utc: '2026-07-31T21:00:00.000Z',
            as_of_utc: '2026-07-31T12:00:00.000Z',
          }] };
        }
        if (/client_report_pipeline_summary\(/i.test(sql)) {
          throw new Error('canceling statement due to statement timeout');
        }
        return { rows: [] };
      }),
    };
    const target = new subject.PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds: ['campaign-a'],
    });

    await expect(target.verifyParity(runId)).rejects.toThrow(/timeout/i);
    expect(statements.at(-1)).toBe('ROLLBACK');
  });
});
