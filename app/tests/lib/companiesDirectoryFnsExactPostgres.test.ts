/** @jest-environment node */

import {
  computeFnsExactPreviewFingerprint,
  executeFnsExactApply,
  executeFnsExactCheck,
  type FnsExactImportPreviewBody,
} from '@/lib/companiesDirectory/fnsExactApply';
import {
  FnsExactPostgresApplySession,
  verifyFnsExactDatabaseIdentity,
  type FnsExactPgClient,
} from '@/lib/companiesDirectory/fnsExactPostgresApply';

const PLAN_FINGERPRINT = 'a'.repeat(64);
const FNS_SOURCE = 'fns_sme_registry';

const UPDATES = [
  {
    id: '10',
    inn: '7704414297',
    expected_ogrn: '1177746494166',
    fns_ogrn: '1177746494166',
    match_method: 'ogrn_inn',
    okved_code_exact: '62.01',
    okved_exact_source: FNS_SOURCE,
  },
  {
    id: '11',
    inn: '7729058675',
    expected_ogrn: null,
    fns_ogrn: '1177746494177',
    match_method: 'unique_inn_fallback',
    okved_code_exact: '62.09',
    okved_exact_source: FNS_SOURCE,
  },
] as const;

function previewRow(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    staged_updates: '2',
    rows_to_update: '2',
    already_applied: '0',
    missing_targets: '0',
    identity_mismatches: '0',
    conflicting_values: '0',
    state_digest: 'b'.repeat(64),
    ...overrides,
  };
}

function previewBody(
  overrides: Partial<FnsExactImportPreviewBody> = {},
): FnsExactImportPreviewBody {
  return {
    stagedUpdates: 2,
    rowsToUpdate: 2,
    alreadyApplied: 0,
    missingTargets: 0,
    identityMismatches: 0,
    conflictingValues: 0,
    stateDigest: 'b'.repeat(64),
    ...overrides,
  };
}

function makeQuery(
  onQuery?: (
    sql: string,
    values: unknown[] | undefined,
  ) => Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  } | undefined> | {
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  } | undefined,
) {
  return jest.fn(
    async (sql: string, values?: unknown[]) => {
      if (onQuery) {
        const overridden = await onQuery(sql, values);
        if (overridden) return overridden;
      }
      if (sql.includes('jsonb_to_recordset')) {
        const rows = JSON.parse(String(values?.[0])) as unknown[];
        return { rows: [], rowCount: rows.length };
      }
      return { rows: [], rowCount: null };
    },
  );
}

function makeSession(input: {
  query: ReturnType<typeof makeQuery>;
  planFingerprint?: string;
  processArtifacts?: ConstructorParameters<
    typeof FnsExactPostgresApplySession
  >[0]['processArtifacts'];
}) {
  const client: FnsExactPgClient = { query: input.query };
  return new FnsExactPostgresApplySession({
    client,
    expectedPlanFingerprint: input.planFingerprint ?? PLAN_FINGERPRINT,
    processArtifacts: input.processArtifacts ?? (async ({ onUpdateBatch }) => {
      await onUpdateBatch([...UPDATES]);
      return { planFingerprint: PLAN_FINGERPRINT };
    }),
  });
}

describe('FNS exact OKVED Postgres apply session', () => {
  it('stages only update rows through parameterized JSONB batches', async () => {
    const query = makeQuery();
    let callbackKeys: string[] = [];
    const session = makeSession({
      query,
      processArtifacts: async (callbacks) => {
        callbackKeys = Object.keys(callbacks).sort();
        await callbacks.onUpdateBatch([...UPDATES]);
        return { planFingerprint: PLAN_FINGERPRINT };
      },
    });

    await session.beginReadWrite();
    await session.acquireAdvisoryLock();
    await session.stageArtifacts();

    expect(callbackKeys).toEqual(['onUpdateBatch']);
    const statements = query.mock.calls.map(([sql]) => sql);
    const createStageSql = statements.find((sql) =>
      sql.startsWith('CREATE TEMP TABLE')
    );
    expect(createStageSql).toBeDefined();
    expect(createStageSql).toMatch(/id\s+bigint\s+PRIMARY\s+KEY/i);
    expect(createStageSql).toContain('expected_ogrn');
    expect(createStageSql).toContain('fns_ogrn');
    expect(createStageSql).toContain('match_method');
    expect(createStageSql).not.toMatch(/\bkind\b/i);

    const stageCall = query.mock.calls.find(([sql]) =>
      sql.includes('jsonb_to_recordset')
    );
    expect(stageCall).toBeDefined();
    expect(stageCall?.[0]).toContain('$1::jsonb');
    expect(stageCall?.[1]).toHaveLength(1);
    expect(JSON.parse(String(stageCall?.[1]?.[0]))).toEqual(UPDATES);
    expect(
      query.mock.calls
        .filter(([sql]) => sql.includes('jsonb_to_recordset'))
        .every(([, values]) => Array.isArray(values)),
    ).toBe(true);

    const allSql = statements.join('\n');
    expect(allSql).not.toMatch(
      /INSERT\s+INTO\s+public\.companies_directory/i,
    );
  });

  it('rechecks the audited plan fingerprint while staging and rolls back drift', async () => {
    const query = makeQuery();
    const session = makeSession({
      query,
      processArtifacts: async ({ onUpdateBatch }) => {
        await onUpdateBatch([...UPDATES]);
        return { planFingerprint: 'c'.repeat(64) };
      },
    });

    await expect(
      executeFnsExactApply(session, 'd'.repeat(64), 1_000),
    ).rejects.toThrow(/plan fingerprint changed/i);

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('ROLLBACK');
    expect(statements.join('\n')).not.toMatch(
      /(?:INSERT|UPDATE)\s+public\.companies_directory/i,
    );
  });

  it('returns the complete exact-state classification and deterministic digest', async () => {
    const row = previewRow({
      rows_to_update: '1',
      already_applied: '1',
      state_digest: 'd'.repeat(64),
    });
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        return { rows: [row], rowCount: 1 };
      }
      return undefined;
    });
    const session = makeSession({ query });

    await session.beginReadWrite();
    await session.acquireAdvisoryLock();
    await session.stageArtifacts();
    const preview = await session.preview();

    const body = previewBody({
      rowsToUpdate: 1,
      alreadyApplied: 1,
      stateDigest: 'd'.repeat(64),
    });
    expect(preview).toEqual({
      ...body,
      fingerprint: computeFnsExactPreviewFingerprint(body),
    });

    const previewSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('AS staged_updates'));
    expect(previewSql).toContain('rows_to_update');
    expect(previewSql).toContain('already_applied');
    expect(previewSql).toContain('missing_targets');
    expect(previewSql).toContain('identity_mismatches');
    expect(previewSql).toContain('conflicting_values');
    expect(previewSql).toContain('state_digest');
    expect(previewSql).toMatch(/c\.id\s*=\s*s\.id/i);
    expect(previewSql).toMatch(/c\.inn\s*=\s*s\.inn/i);
    expect(previewSql).toMatch(
      /c\.ogrn\s+IS\s+NOT\s+DISTINCT\s+FROM\s+s\.expected_ogrn/i,
    );
    expect(previewSql).toMatch(/by_id\.ogrn/i);
    expect(previewSql).toMatch(/s\.fns_ogrn/i);
    expect(previewSql).toMatch(/s\.match_method/i);
    expect(previewSql).toMatch(/okved_code_exact\s+IS\s+NULL/i);
    expect(previewSql).toMatch(/okved_exact_source\s+IS\s+NULL/i);
    expect(previewSql).toContain(FNS_SOURCE);
  });

  it('rejects a malformed live-state digest', async () => {
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        return {
          rows: [previewRow({ state_digest: 'not-a-sha256' })],
          rowCount: 1,
        };
      }
      return undefined;
    });
    const session = makeSession({ query });

    await session.beginReadWrite();
    await session.acquireAdvisoryLock();
    await session.stageArtifacts();

    await expect(session.preview()).rejects.toThrow(/state digest/i);
  });

  it('applies bounded batches in one transaction without inserts or a table lock', async () => {
    let previewCalls = 0;
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        previewCalls += 1;
        return {
          rows: [
            previewCalls === 1
              ? previewRow()
              : previewRow({
                  rows_to_update: '0',
                  already_applied: '2',
                  state_digest: 'e'.repeat(64),
                }),
          ],
          rowCount: 1,
        };
      }
      if (/UPDATE\s+public\.companies_directory/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return undefined;
    });
    const session = makeSession({ query });
    const before = previewBody();

    await expect(
      executeFnsExactApply(
        session,
        computeFnsExactPreviewFingerprint(before),
        1,
      ),
    ).resolves.toMatchObject({
      updated: 2,
      alreadyApplied: false,
    });

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(
      statements.filter((sql) => sql === 'BEGIN READ WRITE'),
    ).toHaveLength(1);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(statements).not.toContain('ROLLBACK');
    expect(
      statements.filter((sql) => sql.includes('pg_advisory_xact_lock')),
    ).toHaveLength(1);
    expect(statements.some((sql) => /LOCK\s+TABLE/i.test(sql))).toBe(false);
    expect(session).not.toHaveProperty('lockTargetTable');

    const allSql = statements.join('\n');
    expect(allSql).not.toMatch(
      /INSERT\s+INTO\s+public\.companies_directory/i,
    );
    const updateCalls = query.mock.calls.filter(([sql]) =>
      /UPDATE\s+public\.companies_directory/i.test(sql)
    );
    expect(updateCalls).toHaveLength(2);
    for (const [sql, values] of updateCalls) {
      expect(sql).toMatch(/c\.id\s*=\s*\w+\.(?:id|expected_id)/i);
      expect(sql).toMatch(/c\.inn\s*=\s*\w+\.inn/i);
      expect(sql).toMatch(
        /c\.ogrn\s+IS\s+NOT\s+DISTINCT\s+FROM\s+\w+\.expected_ogrn/i,
      );
      expect(sql).toMatch(/c\.okved_code_exact\s+IS\s+NULL/i);
      expect(sql).toMatch(/c\.okved_exact_source\s+IS\s+NULL/i);
      expect(sql).toMatch(/LIMIT\s+\$\d+/i);
      expect(`${sql}\n${JSON.stringify(values)}`).toContain(FNS_SOURCE);
      expect(values).toContain(1);
    }
  });

  it('treats live OGRN drift as an identity mismatch and never updates by id+INN alone', async () => {
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        return {
          rows: [previewRow({
            rows_to_update: '1',
            identity_mismatches: '1',
            state_digest: 'f'.repeat(64),
          })],
          rowCount: 1,
        };
      }
      return undefined;
    });
    const session = makeSession({ query });

    await expect(executeFnsExactApply(
      session,
      computeFnsExactPreviewFingerprint(previewBody({
        rowsToUpdate: 1,
        identityMismatches: 1,
        stateDigest: 'f'.repeat(64),
      })),
      1_000,
    )).rejects.toThrow(/identity/i);

    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE\s+public\.companies_directory/i.test(sql)
      ),
    ).toBe(false);
  });

  it.each([0, -1, 100_001, 1.5, Number.NaN])(
    'rejects invalid update batch limit %s before SQL',
    async (limit) => {
      const query = makeQuery();
      const session = makeSession({ query });

      await expect(session.updateNextBatch(limit)).rejects.toThrow(
        /batch.*between 1 and 100000/i,
      );
      expect(
        query.mock.calls.some(([sql]) =>
          /UPDATE\s+public\.companies_directory/i.test(sql)
        ),
      ).toBe(false);
    },
  );

  it('creates the session-local stage before BEGIN READ ONLY in check mode', async () => {
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        return { rows: [previewRow()], rowCount: 1 };
      }
      return undefined;
    });
    const session = makeSession({ query });

    await expect(executeFnsExactCheck(session)).resolves.toMatchObject({
      stagedUpdates: 2,
      rowsToUpdate: 2,
    });

    const statements = query.mock.calls.map(([sql]) => sql);
    const createIndex = statements.findIndex((sql) =>
      sql.startsWith('CREATE TEMP TABLE')
    );
    const beginIndex = statements.indexOf('BEGIN READ ONLY');
    const stageIndex = statements.findIndex((sql) =>
      sql.includes('jsonb_to_recordset')
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeLessThan(beginIndex);
    expect(stageIndex).toBeGreaterThan(beginIndex);
    expect(statements).toContain('ROLLBACK');
    expect(statements.some((sql) => sql.startsWith('ANALYZE'))).toBe(false);
    expect(
      statements.some((sql) => sql.includes('pg_advisory_xact_lock')),
    ).toBe(false);
    expect(statements.some((sql) => /LOCK\s+TABLE/i.test(sql))).toBe(false);
    expect(statements.join('\n')).not.toMatch(
      /(?:INSERT|UPDATE)\s+public\.companies_directory/i,
    );
  });

  it('verifies the Portal database identity before use', async () => {
    const goodClient: FnsExactPgClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          database: 'postgres',
          directory_table: 'companies_directory',
        }],
        rowCount: 1,
      }),
    };
    await expect(verifyFnsExactDatabaseIdentity(goodClient)).resolves.toEqual({
      database: 'postgres',
      directoryTable: 'companies_directory',
    });

    const wrongClient: FnsExactPgClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          database: 'instantly',
          directory_table: null,
        }],
        rowCount: 1,
      }),
    };
    await expect(
      verifyFnsExactDatabaseIdentity(wrongClient),
    ).rejects.toThrow(/database identity/i);
  });
});
