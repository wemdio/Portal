/** @jest-environment node */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSbisApplyAuthorized,
  assertSbisProductionTarget,
  assertTrustedSbisV4PlanFingerprint,
  buildSbisPlanFingerprint,
  computeSbisFillEmptyPatch,
  computeSbisPreviewFingerprint,
  executeSbisApply,
  executeSbisCheck,
  parseSbisApplyCliArgs,
  validateSbisInsertRow,
  validateSbisPlanManifest,
  validateSbisUpdateRow,
  type SbisApplySession,
  type SbisImportPreview,
  type SbisPlanManifest,
} from '@/lib/companiesDirectory/sbisPlanApply';
import { processSbisPlanFiles } from '@/lib/companiesDirectory/sbisPlanFiles';
import {
  SbisPostgresApplySession,
  verifySbisDatabaseIdentity,
  type SbisPgClient,
} from '@/lib/companiesDirectory/sbisPostgresApply';
import frozenSbisV4Manifest from '../../scripts/sbis-directory-v4.manifest.json';

const MANIFEST: SbisPlanManifest = {
  version: 1,
  plan: 'sbis-directory-v4',
  target: {
    host: '139.60.162.12',
    port: 35434,
    database: 'postgres',
  },
  sources: [
    {
      sourceFile: 'Компании (1).xlsx',
      sha256:
        '82137400e43f746127f44d43662db72dbd67395a60d2dc5a6997b57776e76d31',
      inputRows: 18_787,
      uniqueInns: 18_528,
    },
    {
      sourceFile: 'Компании (2).xlsx',
      sha256:
        '8e8d117433ecb3d7d3063fb5aeca0ae889fc7f89f71df9f48f8435b199b7c36c',
      inputRows: 100_000,
      uniqueInns: 100_000,
    },
  ],
  artifacts: {
    'summary.json': {
      sha256: 'a'.repeat(64),
    },
    'inserts.jsonl': {
      sha256: 'b'.repeat(64),
      rows: 2,
    },
    'updates.jsonl': {
      sha256: 'c'.repeat(64),
      rows: 1,
    },
    'rejected.jsonl': {
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      rows: 0,
    },
  },
  expected: {
    inputRows: 118_787,
    uniqueIncomingInns: 110_278,
    inserts: 2,
    updates: 1,
    skipped: 12,
    rejectedRows: 0,
    approximateOkvedCounts: {
      '62.0': 1,
      '46.51': 1,
    },
  },
};

const SUMMARY = {
  dryRunOnly: true,
  mode: 'contact-only',
  input: {
    files: MANIFEST.sources.map((source) => ({
      file: `C:\\source\\${source.sourceFile}`,
      ...source,
    })),
  },
  combined: {
    inputRows: MANIFEST.expected.inputRows,
    uniqueIncomingInns: MANIFEST.expected.uniqueIncomingInns,
    inserts: MANIFEST.expected.inserts,
    updates: MANIFEST.expected.updates,
    skipped: MANIFEST.expected.skipped,
    rejectedRows: MANIFEST.expected.rejectedRows,
    approximateOkvedCounts: [
      ['62.0', 1],
      ['46.51', 1],
    ],
  },
  idempotencyCheck: {
    repeatedInserts: 0,
    repeatedUpdates: 0,
    passed: true,
  },
};

const INSERT_62 = {
  name: 'ООО "АЛЬФА"',
  inn: '7704414297',
  kpp: '770401001',
  address: 'г. Москва',
  director_last_name: null,
  director_first_name: null,
  director_middle_name: null,
  activity_type: 'Программное обеспечение',
  employees_count: 12,
  phones: null,
  email: 'hello@alpha.ru',
  revenue: 100,
  cost: 50,
  edo_id: null,
  okpo: null,
  pf_reg_number: null,
  branch_code: null,
  website: null,
  egais: null,
  gln: null,
  ogrn: '1177746494166',
  region_code: '77',
  okved_code: '62.0',
  okved_code_exact: null,
  okved_exact_source: null,
  source_file: 'Компании (1).xlsx',
};

const INSERT_4651 = {
  ...INSERT_62,
  name: 'ООО "БЕТА"',
  inn: '772138583200',
  activity_type:
    'Компьютеры и комплектующие, вычислительная техника, оргтехника',
  email: null,
  website: 'beta.ru',
  okved_code: '46.51',
  source_file: 'Компании (2).xlsx',
};

function makePreview(
  overrides: Partial<Omit<SbisImportPreview, 'fingerprint'>> = {},
): SbisImportPreview {
  const body = {
    stagedInserts: 2,
    stagedUpdates: 1,
    missingInserts: 2,
    alreadyPresentInserts: 0,
    rowsToUpdate: 1,
    missingUpdateTargets: 0,
    duplicateTargetInns: 0,
    conflictingPresentInserts: 0,
    mismatchedUpdateTargets: 0,
    conflictingUpdateValues: 0,
    stateDigest: 'state-before',
    ...overrides,
  };
  return {
    ...body,
    fingerprint: computeSbisPreviewFingerprint(body),
  };
}

function makeSession(previews: SbisImportPreview[]): jest.Mocked<SbisApplySession> {
  return {
    beginReadOnly: jest.fn().mockResolvedValue(undefined),
    beginReadWrite: jest.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    stageArtifacts: jest.fn().mockResolvedValue(undefined),
    lockTargetTable: jest.fn().mockResolvedValue(undefined),
    preview: jest.fn().mockImplementation(async () => {
      const next = previews.shift();
      if (!next) throw new Error('No preview configured');
      return next;
    }),
    insertMissing: jest.fn().mockResolvedValue(2),
    fillEmpty: jest.fn().mockResolvedValue(1),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('SBIS production import guardrails', () => {
  it('defaults to check mode and never invokes persistent writes', async () => {
    expect(parseSbisApplyCliArgs(['--plan-dir', 'C:\\plan'])).toMatchObject({
      mode: 'check',
      planDir: 'C:\\plan',
    });

    const before = makePreview();
    const session = makeSession([before]);
    const result = await executeSbisCheck(session);

    expect(result).toEqual(before);
    expect(session.beginReadOnly).toHaveBeenCalledTimes(1);
    expect(session.stageArtifacts).toHaveBeenCalledTimes(1);
    expect(session.insertMissing).not.toHaveBeenCalled();
    expect(session.fillEmpty).not.toHaveBeenCalled();
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).toHaveBeenCalledTimes(1);
  });

  it('requires explicit apply plus exact plan and live-preview fingerprints', () => {
    const planFingerprint = buildSbisPlanFingerprint(MANIFEST);
    const previewFingerprint = makePreview().fingerprint;

    expect(() =>
      assertSbisApplyAuthorized({
        mode: 'check',
        planFingerprint,
        confirmedPlanFingerprint: planFingerprint,
        previewFingerprint,
        confirmedPreviewFingerprint: previewFingerprint,
      }),
    ).toThrow('--apply');

    expect(() =>
      assertSbisApplyAuthorized({
        mode: 'apply',
        planFingerprint,
        confirmedPlanFingerprint: '0'.repeat(64),
        previewFingerprint,
        confirmedPreviewFingerprint: previewFingerprint,
      }),
    ).toThrow('plan fingerprint');

    expect(() =>
      assertSbisApplyAuthorized({
        mode: 'apply',
        planFingerprint,
        confirmedPlanFingerprint: planFingerprint,
        previewFingerprint,
        confirmedPreviewFingerprint: '0'.repeat(64),
      }),
    ).toThrow('preview fingerprint');

    expect(() =>
      assertSbisApplyAuthorized({
        mode: 'apply',
        planFingerprint,
        confirmedPlanFingerprint: planFingerprint,
        previewFingerprint,
        confirmedPreviewFingerprint: previewFingerprint,
      }),
    ).not.toThrow();
  });

  it('pins apply to the code-reviewed frozen v4 manifest', () => {
    const frozenFingerprint = buildSbisPlanFingerprint(
      frozenSbisV4Manifest as SbisPlanManifest,
    );
    expect(frozenFingerprint).toBe(
      'd36c06f13f09ac9f6ad3c26102b9c29dd87cf83ecd79dd7b2cf5c7068d87ba08',
    );
    expect(() =>
      assertTrustedSbisV4PlanFingerprint(frozenFingerprint),
    ).not.toThrow();
    expect(() =>
      assertTrustedSbisV4PlanFingerprint(buildSbisPlanFingerprint(MANIFEST)),
    ).toThrow('trusted frozen');
  });

  it('rejects any frozen manifest, artifact hash, count, or idempotency drift', () => {
    const valid = {
      manifest: MANIFEST,
      summary: SUMMARY,
      artifactHashes: Object.fromEntries(
        Object.entries(MANIFEST.artifacts).map(([name, artifact]) => [
          name,
          artifact.sha256,
        ]),
      ),
      artifactRows: {
        'inserts.jsonl': 2,
        'updates.jsonl': 1,
        'rejected.jsonl': 0,
      },
      approximateOkvedCounts: {
        '62.0': 1,
        '46.51': 1,
      },
    };

    expect(validateSbisPlanManifest(valid).planFingerprint).toBe(
      buildSbisPlanFingerprint(MANIFEST),
    );
    expect(() =>
      validateSbisPlanManifest({
        ...valid,
        artifactHashes: {
          ...valid.artifactHashes,
          'updates.jsonl': '0'.repeat(64),
        },
      }),
    ).toThrow('updates.jsonl');
    expect(() =>
      validateSbisPlanManifest({
        ...valid,
        artifactRows: {
          ...valid.artifactRows,
          'inserts.jsonl': 1,
        },
      }),
    ).toThrow('inserts.jsonl');
    expect(() =>
      validateSbisPlanManifest({
        ...valid,
        summary: {
          ...SUMMARY,
          idempotencyCheck: {
            ...SUMMARY.idempotencyCheck,
            passed: false,
          },
        },
      }),
    ).toThrow('idempotency');
  });

  it('validates every INN, mapping, contact, exact-OKVED null, and update allowlist', () => {
    expect(validateSbisInsertRow(INSERT_62)).toEqual(INSERT_62);
    expect(validateSbisInsertRow(INSERT_4651)).toEqual(INSERT_4651);
    expect(() =>
      validateSbisInsertRow({
        ...INSERT_62,
        inn: '1234567890',
      }),
    ).toThrow('INN');
    expect(() =>
      validateSbisInsertRow({
        ...INSERT_62,
        email: null,
        website: null,
      }),
    ).toThrow('website or email');
    expect(() =>
      validateSbisInsertRow({
        ...INSERT_62,
        okved_code: '62.01',
      }),
    ).toThrow('approximate OKVED');
    expect(() =>
      validateSbisInsertRow({
        ...INSERT_62,
        okved_code_exact: '62.01',
      }),
    ).toThrow('exact OKVED');
    expect(() =>
      validateSbisInsertRow({
        ...INSERT_62,
        employees_count: 'twelve',
      }),
    ).toThrow('employees_count');
    expect(() =>
      validateSbisInsertRow({
        ...INSERT_62,
        revenue: 1.5,
      }),
    ).toThrow('revenue');

    expect(
      validateSbisUpdateRow({
        id: '10',
        inn: '7704414297',
        patch: {
          email: 'new@alpha.ru',
          okved_code: '62.0',
        },
      }),
    ).toMatchObject({ inn: '7704414297' });
    expect(() =>
      validateSbisUpdateRow({
        id: '10',
        inn: '7704414297',
        patch: {
          employees_count: 99,
        },
      }),
    ).toThrow('employees_count');
    expect(() =>
      validateSbisUpdateRow({
        id: 'not-an-id',
        inn: '7704414297',
        patch: {
          email: 'new@alpha.ru',
        },
      }),
    ).toThrow('audit id');
    expect(() =>
      validateSbisUpdateRow({
        id: '9223372036854775808',
        inn: '7704414297',
        patch: {
          email: 'new@alpha.ru',
        },
      }),
    ).toThrow('audit id');
  });

  it('streams, hashes, batches, and revalidates the exact artifacts before staging', async () => {
    const planDir = await mkdtemp(join(tmpdir(), 'sbis-plan-test-'));
    try {
      const summaryText = `${JSON.stringify(SUMMARY)}\n`;
      const mergedSourceInsert = {
        ...INSERT_4651,
        source_file: 'Компании (1).xlsx, Компании (2).xlsx',
      };
      const insertsText = `${JSON.stringify(INSERT_62)}\n${JSON.stringify(mergedSourceInsert)}\n`;
      const updatesText = `${JSON.stringify({
        id: '10',
        inn: '165706088568',
        patch: { okved_code: '62.0' },
      })}\n`;
      const rejectedText = '';
      const manifest: SbisPlanManifest = {
        ...MANIFEST,
        artifacts: {
          'summary.json': { sha256: hash(summaryText) },
          'inserts.jsonl': { sha256: hash(insertsText), rows: 2 },
          'updates.jsonl': { sha256: hash(updatesText), rows: 1 },
          'rejected.jsonl': { sha256: hash(rejectedText), rows: 0 },
        },
      };
      const manifestPath = join(planDir, 'manifest.json');
      await Promise.all([
        writeFile(join(planDir, 'summary.json'), summaryText),
        writeFile(join(planDir, 'inserts.jsonl'), insertsText),
        writeFile(join(planDir, 'updates.jsonl'), updatesText),
        writeFile(join(planDir, 'rejected.jsonl'), rejectedText),
        writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
      ]);

      const insertBatches: unknown[][] = [];
      const updateBatches: unknown[][] = [];
      const inspected = await processSbisPlanFiles({
        planDir,
        manifestPath,
        batchSize: 1,
        onInsertBatch: async (rows) => {
          insertBatches.push(rows);
        },
        onUpdateBatch: async (rows) => {
          updateBatches.push(rows);
        },
      });

      expect(inspected).toMatchObject({
        planFingerprint: buildSbisPlanFingerprint(manifest),
        insertRows: 2,
        updateRows: 1,
      });
      expect(insertBatches).toEqual([[INSERT_62], [mergedSourceInsert]]);
      expect(updateBatches).toHaveLength(1);

      await writeFile(
        join(planDir, 'inserts.jsonl'),
        `${insertsText}${JSON.stringify(INSERT_62)}\n`,
      );
      await expect(
        processSbisPlanFiles({ planDir, manifestPath }),
      ).rejects.toThrow(/inserts\.jsonl (SHA-256|row count|contains duplicate)/);
    } finally {
      await rm(planDir, { recursive: true, force: true });
    }
  });

  it('accepts only the current production endpoint and rejects the former host', () => {
    expect(
      assertSbisProductionTarget(
        'postgresql://139.60.162.12:35434/postgres',
        '139.60.162.12',
      ),
    ).toEqual({
      host: '139.60.162.12',
      port: 35434,
      database: 'postgres',
    });
    expect(() =>
      assertSbisProductionTarget(
        'postgresql://144.31.54.166:35434/postgres',
        '139.60.162.12',
      ),
    ).toThrow('former');
    expect(() =>
      assertSbisProductionTarget(
        'postgresql://main-postgres:5432/postgres',
        '139.60.162.12',
      ),
    ).toThrow('host');
    expect(() =>
      assertSbisProductionTarget(
        'postgresql://139.60.162.12:35434/instantly',
        '139.60.162.12',
      ),
    ).toThrow('database');
    expect(() =>
      assertSbisProductionTarget(
        'postgresql://139.60.162.12:35434/postgres?host=144.31.54.166&port=35434',
        '139.60.162.12',
      ),
    ).toThrow('query parameter');
  });

  it('fills only blank contact/mapped-industry fields and preserves exact data', () => {
    expect(
      computeSbisFillEmptyPatch(
        {
          phones: null,
          email: 'current@alpha.ru',
          website: '   ',
          okved_code: null,
          okved_code_exact: '62.01',
          okved_exact_source: 'dadata',
        },
        {
          phones: '+74951112233',
          email: 'incoming@alpha.ru',
          website: 'alpha.ru',
          okved_code: '62.0',
          okved_code_exact: null,
          okved_exact_source: null,
        },
      ),
    ).toEqual({
      phones: '+74951112233',
      website: 'alpha.ru',
      okved_code: '62.0',
    });
  });

  it('rolls back before DML when the live target contains duplicate INNs', async () => {
    const duplicate = makePreview({
      duplicateTargetInns: 1,
      stateDigest: 'duplicate',
    });
    const session = makeSession([duplicate]);

    await expect(
      executeSbisApply(session, duplicate.fingerprint),
    ).rejects.toThrow('duplicate INN');
    expect(session.insertMissing).not.toHaveBeenCalled();
    expect(session.fillEmpty).not.toHaveBeenCalled();
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['conflicting existing insert', { conflictingPresentInserts: 1 }],
    ['mismatched update identity', { mismatchedUpdateTargets: 1 }],
    ['conflicting update value', { conflictingUpdateValues: 1 }],
  ])('rolls back before DML for %s', async (_label, unsafeState) => {
    const unsafe = makePreview({
      ...unsafeState,
      stateDigest: 'unsafe',
    });
    const session = makeSession([unsafe]);

    await expect(
      executeSbisApply(session, unsafe.fingerprint),
    ).rejects.toThrow(/conflict|identity/i);
    expect(session.insertMissing).not.toHaveBeenCalled();
    expect(session.fillEmpty).not.toHaveBeenCalled();
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).toHaveBeenCalledTimes(1);
  });

  it('is atomic, checks affected counts, and a repeat becomes a no-op', async () => {
    const before = makePreview();
    const after = makePreview({
      missingInserts: 0,
      alreadyPresentInserts: 2,
      rowsToUpdate: 0,
      stateDigest: 'state-after',
    });
    const successful = makeSession([before, after]);

    await expect(
      executeSbisApply(successful, before.fingerprint),
    ).resolves.toEqual({
      inserted: 2,
      updated: 1,
      alreadyApplied: false,
      before,
      after,
    });
    expect(successful.commit).toHaveBeenCalledTimes(1);
    expect(successful.rollback).not.toHaveBeenCalled();

    const repeated = makeSession([after]);
    await expect(
      executeSbisApply(repeated, before.fingerprint),
    ).resolves.toMatchObject({
      inserted: 0,
      updated: 0,
      alreadyApplied: true,
    });
    expect(repeated.insertMissing).not.toHaveBeenCalled();
    expect(repeated.fillEmpty).not.toHaveBeenCalled();
    expect(repeated.commit).toHaveBeenCalledTimes(1);

    const failing = makeSession([before]);
    failing.insertMissing.mockRejectedValueOnce(new Error('batch failed'));
    await expect(
      executeSbisApply(failing, before.fingerprint),
    ).rejects.toThrow('batch failed');
    expect(failing.commit).not.toHaveBeenCalled();
    expect(failing.rollback).toHaveBeenCalledTimes(1);

    const mismatch = makeSession([before]);
    mismatch.insertMissing.mockResolvedValueOnce(1);
    await expect(
      executeSbisApply(mismatch, before.fingerprint),
    ).rejects.toThrow('inserted row count');
    expect(mismatch.commit).not.toHaveBeenCalled();
    expect(mismatch.rollback).toHaveBeenCalledTimes(1);
  });

  it('stages through parameterized JSONB and uses guarded fill-empty SQL', async () => {
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO sbis_directory_import_stage')) {
        const staged = JSON.parse(String(values?.[0])) as unknown[];
        return { rows: [], rowCount: staged.length };
      }
      if (sql.includes('AS staged_inserts')) {
        return {
          rows: [{
            staged_inserts: '2',
            staged_updates: '1',
            missing_inserts: '2',
            already_present_inserts: '0',
            rows_to_update: '1',
            missing_update_targets: '0',
            duplicate_target_inns: '0',
            conflicting_present_inserts: '0',
            mismatched_update_targets: '0',
            conflicting_update_values: '0',
            state_digest: 'a'.repeat(32),
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('INSERT INTO public.companies_directory')) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.startsWith('UPDATE public.companies_directory')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    });
    const client: SbisPgClient = { query };
    const session = new SbisPostgresApplySession({
      client,
      expectedPlanFingerprint: buildSbisPlanFingerprint(MANIFEST),
      processArtifacts: async ({ onInsertBatch, onUpdateBatch }) => {
        await onInsertBatch([INSERT_62, INSERT_4651]);
        await onUpdateBatch([{
          id: '10',
          inn: '165706088568',
          patch: { okved_code: '62.0' },
        }]);
        return {
          planFingerprint: buildSbisPlanFingerprint(MANIFEST),
        };
      },
    });

    await session.beginReadWrite();
    await session.acquireAdvisoryLock();
    await session.stageArtifacts();
    await session.lockTargetTable();
    const preview = await session.preview();
    await expect(session.insertMissing()).resolves.toBe(2);
    await expect(session.fillEmpty()).resolves.toBe(1);
    await session.commit();

    expect(preview).toMatchObject({
      stagedInserts: 2,
      stagedUpdates: 1,
      missingInserts: 2,
      rowsToUpdate: 1,
      conflictingPresentInserts: 0,
      mismatchedUpdateTargets: 0,
      conflictingUpdateValues: 0,
      stateDigest: 'a'.repeat(32),
    });
    const sqlCalls = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(sqlCalls).toContain('UNIQUE (inn)');
    expect(sqlCalls).toContain('pg_advisory_xact_lock');
    expect(sqlCalls).toContain('LOCK TABLE public.companies_directory');
    expect(sqlCalls).toContain('okved_code_exact');
    expect(sqlCalls).toContain('NULL::text');
    expect(sqlCalls).toContain("NULLIF(BTRIM(c.email), '') IS NULL");
    const updateSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.startsWith('UPDATE public.companies_directory'));
    expect(updateSql).toContain("s.kind = 'update'");
    expect(updateSql).toContain('c.id = staged.expected_id');
    expect(query.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO sbis_directory_import_stage')
    ).every(([, values]) => Array.isArray(values))).toBe(true);
  });

  it('creates only a session-local temp table before entering read-only check mode', async () => {
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO sbis_directory_import_stage')) {
        const staged = JSON.parse(String(values?.[0])) as unknown[];
        return { rows: [], rowCount: staged.length };
      }
      return { rows: [], rowCount: null };
    });
    const session = new SbisPostgresApplySession({
      client: { query },
      expectedPlanFingerprint: buildSbisPlanFingerprint(MANIFEST),
      processArtifacts: async ({ onInsertBatch }) => {
        await onInsertBatch([INSERT_62]);
        return {
          planFingerprint: buildSbisPlanFingerprint(MANIFEST),
        };
      },
    });

    await session.beginReadOnly();
    await session.stageArtifacts();

    const statements = query.mock.calls.map(([sql]) => sql);
    const createIndex = statements.findIndex((sql) =>
      sql.startsWith('CREATE TEMP TABLE')
    );
    const beginIndex = statements.indexOf('BEGIN READ ONLY');
    const stageIndex = statements.findIndex((sql) =>
      sql.startsWith('INSERT INTO sbis_directory_import_stage')
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeLessThan(beginIndex);
    expect(stageIndex).toBeGreaterThan(beginIndex);
    expect(statements.some((sql) => sql.startsWith('ANALYZE'))).toBe(false);
  });

  it('verifies the connected database identity without exposing credentials', async () => {
    const goodClient: SbisPgClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          database: 'postgres',
          directory_table: 'companies_directory',
        }],
        rowCount: 1,
      }),
    };
    await expect(verifySbisDatabaseIdentity(goodClient)).resolves.toEqual({
      database: 'postgres',
      directoryTable: 'companies_directory',
    });

    const wrongClient: SbisPgClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          database: 'instantly',
          directory_table: null,
        }],
        rowCount: 1,
      }),
    };
    await expect(verifySbisDatabaseIdentity(wrongClient)).rejects.toThrow(
      'database identity',
    );
  });
});
