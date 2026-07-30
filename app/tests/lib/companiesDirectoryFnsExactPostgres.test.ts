/** @jest-environment node */

import {
  computeFnsExactPreviewFingerprint,
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

interface FnsExactCopyClient {
  copyFrom(
    sql: string,
    rows: AsyncIterable<string>,
  ): Promise<number>;
}

interface FnsExactBatchPage {
  fromExclusive: string | null;
  toInclusive: string;
  rowCount: number;
}

interface FnsExactResumablePostgresSession {
  acquireSessionAdvisoryLock(): Promise<void>;
  releaseSessionAdvisoryLock(): Promise<void>;
  nextPage(
    afterId: string | null,
    limit: number,
  ): Promise<FnsExactBatchPage | null>;
  beginReadWriteBatch(): Promise<void>;
  lockPageTargets(page: FnsExactBatchPage): Promise<number>;
  previewPage(page: FnsExactBatchPage): Promise<FnsExactImportPreviewBody>;
  verifyAppliedPrefix(
    cursorId: string,
    expectedRows: number,
  ): Promise<void>;
  updatePage(page: FnsExactBatchPage): Promise<number>;
}

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
  copyFrom?: FnsExactCopyClient['copyFrom'];
  planFingerprint?: string;
  processArtifacts?: ConstructorParameters<
    typeof FnsExactPostgresApplySession
  >[0]['processArtifacts'];
}) {
  const copyFrom = input.copyFrom ?? (async (
    _sql: string,
    rows: AsyncIterable<string>,
  ) => {
    let payload = '';
    for await (const chunk of rows) payload += chunk;
    return payload.split('\n').filter(Boolean).length;
  });
  const client = {
    query: input.query,
    copyFrom,
  } as FnsExactPgClient & FnsExactCopyClient;
  return new FnsExactPostgresApplySession({
    client,
    expectedPlanFingerprint: input.planFingerprint ?? PLAN_FINGERPRINT,
    processArtifacts: input.processArtifacts ?? (async ({ onUpdateBatch }) => {
      await onUpdateBatch([...UPDATES]);
      return { planFingerprint: PLAN_FINGERPRINT };
    }),
  });
}

function resumable(
  session: FnsExactPostgresApplySession,
): FnsExactResumablePostgresSession {
  return session as unknown as FnsExactResumablePostgresSession;
}

describe('FNS exact OKVED Postgres apply session', () => {
  it('streams only update rows through COPY and preserves the stage across commits', async () => {
    const query = makeQuery();
    let callbackKeys: string[] = [];
    let copiedPayload = '';
    const copyFrom = jest.fn(async (
      _sql: string,
      rows: AsyncIterable<string>,
    ) => {
      for await (const chunk of rows) copiedPayload += chunk;
      return copiedPayload.split('\n').filter(Boolean).length;
    });
    const session = makeSession({
      query,
      copyFrom,
      processArtifacts: async (callbacks) => {
        callbackKeys = Object.keys(callbacks).sort();
        await callbacks.onUpdateBatch([...UPDATES]);
        return { planFingerprint: PLAN_FINGERPRINT };
      },
    });

    await session.beginReadWrite();
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
    expect(createStageSql).toMatch(/ON\s+COMMIT\s+PRESERVE\s+ROWS/i);
    expect(createStageSql).not.toMatch(/\bkind\b/i);

    expect(copyFrom).toHaveBeenCalledTimes(1);
    const copySql = copyFrom.mock.calls[0]?.[0] ?? '';
    expect(copySql).toMatch(/^COPY\s+fns_exact_okved_import_stage/i);
    expect(copySql).toMatch(/FROM\s+STDIN/i);
    expect(copySql).toContain('expected_ogrn');
    expect(copySql).toContain('fns_ogrn');
    expect(copySql).toContain('match_method');
    expect(copiedPayload.split('\n').filter(Boolean)).toHaveLength(
      UPDATES.length,
    );
    for (const update of UPDATES) {
      expect(copiedPayload).toContain(update.id);
      expect(copiedPayload).toContain(update.inn);
      expect(copiedPayload).toContain(update.fns_ogrn);
      expect(copiedPayload).toContain(update.okved_code_exact);
    }

    const allSql = statements.join('\n');
    expect(allSql).not.toContain('jsonb_to_recordset');
    expect(allSql).not.toMatch(
      /INSERT\s+INTO\s+public\.companies_directory/i,
    );
  });

  it('rejects COPY when PostgreSQL reports fewer staged rows than emitted', async () => {
    const query = makeQuery();
    const copyFrom = jest.fn(async () => UPDATES.length - 1);
    const session = makeSession({ query, copyFrom });

    await session.beginReadWrite();
    await expect(session.stageArtifacts()).rejects.toThrow(
      /staging count.*expected 2.*got 1/i,
    );

    expect(copyFrom).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain(
      'jsonb_to_recordset',
    );
  });

  it('fails fast when COPY rejects before the artifact producer writes', async () => {
    const query = makeQuery();
    const copyFrom = jest.fn(async () => {
      throw new Error('COPY failed immediately');
    });
    const session = makeSession({
      query,
      copyFrom,
      processArtifacts: async ({ onUpdateBatch }) => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await onUpdateBatch([...UPDATES]);
        return { planFingerprint: PLAN_FINGERPRINT };
      },
    });

    const outcome = await Promise.race([
      session.stageArtifacts().then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ status: 'timeout' }), 100);
      }),
    ]);

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toEqual(
        expect.objectContaining({ message: 'COPY failed immediately' }),
      );
    }
  });

  it('holds one session advisory lock across independently committed batches', async () => {
    const query = makeQuery(async (sql) => {
      if (/pg_try_advisory_lock/i.test(sql)) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (/pg_advisory_unlock/i.test(sql)) {
        return { rows: [{ released: true }], rowCount: 1 };
      }
      return undefined;
    });
    const session = makeSession({ query });
    const batchSession = resumable(session);

    await batchSession.acquireSessionAdvisoryLock();
    await batchSession.beginReadWriteBatch();
    await session.commit();
    await batchSession.beginReadWriteBatch();
    await session.commit();
    await batchSession.releaseSessionAdvisoryLock();

    const statements = query.mock.calls.map(([sql]) => sql);
    const lockStatements = statements.filter((sql) =>
      /pg_(?:try_)?advisory_lock\s*\(/i.test(sql)
    );
    expect(lockStatements).toHaveLength(1);
    expect(lockStatements[0]).not.toMatch(/advisory_xact_lock/i);
    expect(
      statements.filter((sql) => /pg_advisory_unlock\s*\(/i.test(sql)),
    ).toHaveLength(1);
    expect(statements.filter((sql) => sql === 'BEGIN READ WRITE')).toHaveLength(2);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(2);
  });

  it('rejects a parallel importer when the session advisory lock is busy', async () => {
    const query = makeQuery(async (sql) => {
      if (/pg_try_advisory_lock/i.test(sql)) {
        return { rows: [{ acquired: false }], rowCount: 1 };
      }
      return undefined;
    });
    const session = resumable(makeSession({ query }));

    await expect(session.acquireSessionAdvisoryLock()).rejects.toThrow(
      /another.*FNS.*import|advisory lock.*busy/i,
    );
    expect(
      query.mock.calls.some(([sql]) => /advisory_xact_lock/i.test(sql)),
    ).toBe(false);
  });

  it('selects bigint stage pages by a lossless keyset cursor, including gaps and the last partial page', async () => {
    const firstLastId = '9007199254740995';
    const finalLastId = '9007199254741999';
    const responses = [
      {
        rows: [{
          from_exclusive: null,
          to_inclusive: firstLastId,
          row_count: '2',
        }],
        rowCount: 1,
      },
      {
        rows: [{
          from_exclusive: firstLastId,
          to_inclusive: finalLastId,
          row_count: '1',
        }],
        rowCount: 1,
      },
      {
        rows: [{
          from_exclusive: finalLastId,
          to_inclusive: null,
          row_count: '0',
        }],
        rowCount: 1,
      },
    ];
    let pageQueryIndex = 0;
    const query = makeQuery(async (sql) => {
      if (
        /FROM\s+fns_exact_okved_import_stage/i.test(sql)
        && /ORDER\s+BY\s+(?:s\.)?id/i.test(sql)
        && /LIMIT\s+\$2/i.test(sql)
      ) {
        const response = responses[pageQueryIndex];
        pageQueryIndex += 1;
        return response;
      }
      return undefined;
    });
    const session = resumable(makeSession({ query }));

    await expect(session.nextPage(null, 2)).resolves.toEqual({
      fromExclusive: null,
      toInclusive: firstLastId,
      rowCount: 2,
    });
    await expect(session.nextPage(firstLastId, 2)).resolves.toEqual({
      fromExclusive: firstLastId,
      toInclusive: finalLastId,
      rowCount: 1,
    });
    await expect(session.nextPage(finalLastId, 2)).resolves.toBeNull();

    const pageCalls = query.mock.calls.filter(([sql]) =>
      /FROM\s+fns_exact_okved_import_stage/i.test(sql)
      && /LIMIT\s+\$2/i.test(sql)
    );
    expect(pageCalls).toHaveLength(3);
    expect(pageCalls[0]?.[1]).toEqual([null, 2]);
    expect(pageCalls[1]?.[1]).toEqual([firstLastId, 2]);
    expect(pageCalls[2]?.[1]).toEqual([finalLastId, 2]);
    for (const [sql] of pageCalls) {
      expect(sql).toMatch(/\$1::bigint\s+IS\s+NULL|id\s*>\s*\$1::bigint/i);
      expect(sql).toMatch(/id\s*>\s*\$1::bigint/i);
      expect(sql).toMatch(/ORDER\s+BY\s+(?:s\.)?id/i);
      expect(sql).not.toMatch(/OFFSET/i);
    }
  });

  it('locks, updates, and post-verifies exactly one bounded page with all identity guards', async () => {
    const page: FnsExactBatchPage = {
      fromExclusive: '10',
      toInclusive: '100',
      rowCount: 3,
    };
    let pagePreviewCalls = 0;
    const query = makeQuery(async (sql) => {
      if (/FOR\s+UPDATE\s+OF\s+c/i.test(sql)) {
        return { rows: [{ id: '11' }, { id: '50' }, { id: '100' }], rowCount: 3 };
      }
      if (sql.includes('AS staged_updates')) {
        pagePreviewCalls += 1;
        return {
          rows: [pagePreviewCalls === 1
            ? previewRow({
                staged_updates: '3',
                rows_to_update: '3',
                already_applied: '0',
              })
            : previewRow({
                staged_updates: '3',
                rows_to_update: '0',
                already_applied: '3',
                state_digest: 'c'.repeat(64),
              })],
          rowCount: 1,
        };
      }
      if (/UPDATE\s+public\.companies_directory/i.test(sql)) {
        return { rows: [], rowCount: 3 };
      }
      return undefined;
    });
    const session = makeSession({ query });
    const batchSession = resumable(session);

    await batchSession.beginReadWriteBatch();
    await expect(batchSession.lockPageTargets(page)).resolves.toBe(3);
    await expect(batchSession.previewPage(page)).resolves.toMatchObject({
      stagedUpdates: 3,
      rowsToUpdate: 3,
      alreadyApplied: 0,
    });
    await expect(batchSession.updatePage(page)).resolves.toBe(3);
    await expect(batchSession.previewPage(page)).resolves.toMatchObject({
      stagedUpdates: 3,
      rowsToUpdate: 0,
      alreadyApplied: 3,
    });
    await session.commit();

    const calls = query.mock.calls;
    const lockCall = calls.find(([sql]) => /FOR\s+UPDATE\s+OF\s+c/i.test(sql));
    const updateCall = calls.find(([sql]) =>
      /UPDATE\s+public\.companies_directory/i.test(sql)
    );
    const previewCalls = calls.filter(([sql]) =>
      sql.includes('AS staged_updates')
    );
    expect(lockCall).toBeDefined();
    expect(updateCall).toBeDefined();
    expect(previewCalls).toHaveLength(2);

    for (const [sql, values] of [lockCall, updateCall, ...previewCalls] as Array<
      [string, unknown[] | undefined]
    >) {
      expect(sql).toMatch(/s\.id\s*>\s*\$1::bigint/i);
      expect(sql).toMatch(/s\.id\s*<=\s*\$2::bigint/i);
      expect(values).toEqual(expect.arrayContaining([
        page.fromExclusive,
        page.toInclusive,
      ]));
    }

    const guardedSql = `${lockCall?.[0]}\n${updateCall?.[0]}`;
    expect(guardedSql).toMatch(/c\.id\s*=\s*s\.id/i);
    expect(guardedSql).toMatch(/c\.inn\s*=\s*s\.inn/i);
    expect(guardedSql).toMatch(
      /c\.ogrn\s+IS\s+NOT\s+DISTINCT\s+FROM\s+s\.expected_ogrn/i,
    );
    expect(guardedSql).toMatch(/c\.okved_code_exact\s+IS\s+NULL/i);
    expect(guardedSql).toMatch(/c\.okved_exact_source\s+IS\s+NULL/i);
    expect(lockCall?.[0]).toMatch(/FOR\s+UPDATE\s+OF\s+c/i);

    const allSql = calls.map(([sql]) => sql).join('\n');
    expect(allSql).not.toMatch(
      /INSERT\s+INTO\s+public\.companies_directory/i,
    );
  });
  it('rechecks the audited plan fingerprint before any target DML', async () => {
    const query = makeQuery();
    const session = makeSession({
      query,
      processArtifacts: async ({ onUpdateBatch }) => {
        await onUpdateBatch([...UPDATES]);
        return { planFingerprint: 'c'.repeat(64) };
      },
    });

    await expect(session.stageArtifacts()).rejects.toThrow(
      /plan fingerprint changed/i,
    );

    const statements = query.mock.calls.map(([sql]) => sql);
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

    await session.stageArtifacts();
    await session.beginReadOnly();

    await expect(session.preview()).rejects.toThrow(/state digest/i);
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

    await expect(executeFnsExactCheck(session)).rejects.toThrow(/identity/i);

    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE\s+public\.companies_directory/i.test(sql)
      ),
    ).toBe(false);
  });

  it.each([0, -1, 100_001, 1.5, Number.NaN])(
    'rejects invalid keyset page limit %s before SQL',
    async (limit) => {
      const query = makeQuery();
      const session = resumable(makeSession({ query }));

      await expect(session.nextPage(null, limit)).rejects.toThrow(
        /page.*between 1 and 100000/i,
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('rejects resume when a committed checkpoint prefix is no longer exact', async () => {
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        return {
          rows: [previewRow({
            staged_updates: '25000',
            rows_to_update: '1',
            already_applied: '24999',
            state_digest: '4'.repeat(64),
          })],
          rowCount: 1,
        };
      }
      return undefined;
    });
    const session = resumable(makeSession({ query }));

    await expect(session.verifyAppliedPrefix(
      '9007199254740993',
      25_000,
    )).rejects.toThrow(/checkpoint prefix.*not fully applied/i);

    const prefixCall = query.mock.calls.find(([sql]) =>
      sql.includes('AS staged_updates')
    );
    expect(prefixCall?.[0]).toMatch(/s\.id\s*<=\s*\$2::bigint/i);
    expect(prefixCall?.[1]).toEqual([null, '9007199254740993']);
    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE\s+public\.companies_directory/i.test(sql)
      ),
    ).toBe(false);
  });

  it('COPY-stages before BEGIN READ ONLY and never mutates the target in check mode', async () => {
    const query = makeQuery(async (sql) => {
      if (sql.includes('AS staged_updates')) {
        return { rows: [previewRow()], rowCount: 1 };
      }
      return undefined;
    });
    const copyFrom = jest.fn(async (
      _sql: string,
      rows: AsyncIterable<string>,
    ) => {
      let rowCount = 0;
      for await (const chunk of rows) {
        rowCount += chunk.split('\n').filter(Boolean).length;
      }
      return rowCount;
    });
    const session = makeSession({ query, copyFrom });

    await expect(executeFnsExactCheck(session)).resolves.toMatchObject({
      stagedUpdates: 2,
      rowsToUpdate: 2,
    });

    const statements = query.mock.calls.map(([sql]) => sql);
    const createIndex = statements.findIndex((sql) =>
      sql.startsWith('CREATE TEMP TABLE')
    );
    const beginIndex = statements.indexOf('BEGIN READ ONLY');
    const analyzeIndex = statements.findIndex((sql) =>
      sql.startsWith('ANALYZE')
    );
    const createCallOrder = query.mock.invocationCallOrder[createIndex];
    const beginCallOrder = query.mock.invocationCallOrder[beginIndex];
    const analyzeCallOrder = query.mock.invocationCallOrder[analyzeIndex];
    const copyCallOrder = copyFrom.mock.invocationCallOrder[0];
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThan(createIndex);
    expect(copyFrom).toHaveBeenCalledTimes(1);
    expect(createCallOrder).toBeLessThan(copyCallOrder);
    expect(copyCallOrder).toBeLessThan(analyzeCallOrder);
    expect(analyzeCallOrder).toBeLessThan(beginCallOrder);
    expect(statements).not.toContain(expect.stringContaining(
      'jsonb_to_recordset',
    ));
    expect(statements).toContain('ROLLBACK');
    expect(statements.filter((sql) => sql.startsWith('ANALYZE'))).toHaveLength(1);
    expect(
      statements.some((sql) => /pg_(?:try_)?advisory_lock/i.test(sql)),
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
