/** @jest-environment node */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFnsExactPlanFingerprint,
  processFnsExactPlanFiles,
  validateFnsExactConflictRow,
  validateFnsExactPlanManifest,
  validateFnsExactSourceQuarantineRow,
  validateFnsExactSkippedRow,
  validateFnsExactUpdateRow,
  type FnsExactPlanManifest,
} from '@/lib/companiesDirectory/fnsExactPlanFiles';

const FNS_SOURCE = 'fns_sme_registry';
const OFFICIAL_ARCHIVE = {
  url: 'https://file.nalog.ru/opendata/7707329152-rsmp/data-10072026-structure-12052026.zip',
  release_date: '2026-07-10',
  bytes: 2_111_054_656,
  sha256: 'a'.repeat(64),
};
const OFFICIAL_XSD = {
  file_name: 'structure-12052026.xsd',
  version: '12052026',
  sha256: '1d90729f30a3b6119f20db6ca34664034950ecacf86f9fae925ab60ce3cf3845',
};
const CURRENT_TARGET = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'companies_directory',
};

const UPDATE = {
  id: '10',
  inn: '7704414297',
  expected_ogrn: '1177746494166',
  fns_ogrn: '1177746494166',
  match_method: 'ogrn_inn',
  okved_code_exact: '62.01',
  okved_exact_source: FNS_SOURCE,
};
const CONFLICT = {
  id: '20',
  inn: '7729058675',
  expected_ogrn: '1177746494177',
  fns_ogrn: '1177746494177',
  match_method: 'ogrn_inn',
  kind: 'existing_exact_preserved',
  existing_okved_code_exact: '62.02.2',
  existing_okved_exact_source: 'dadata',
  incoming_okved_code_exact: '62.09',
  incoming_okved_exact_source: FNS_SOURCE,
};
const SKIPPED = {
  id: '30',
  inn: '212401514249',
  expected_ogrn: null,
  reason: 'ambiguous_inn_multiple_ogrn',
};
const SOURCE_QUARANTINE = {
  inn: '7107064151',
  ogrn: '1027100980065',
  taxpayer_type: 'legal_entity',
  okved_code_exact: '62.01',
  okved_version: '2014',
  document_id: 'doc-invalid-ogrn',
  registry_date: '10.07.2026',
  source_entry_name: 'VO_RRMSP_TEST_20260710_999.xml',
  source_file_id: 'VO_RRMSP_TEST_20260710_999',
  reason: 'invalid_source_ogrn',
  validation_error: 'ОГРН 1027100980065 has an invalid checksum',
};

interface FixtureOptions {
  updatesText?: string;
  conflictsText?: string;
  skippedText?: string;
  sourceQuarantineText?: string;
  updateRows?: number;
  conflictRows?: number;
  skippedRows?: number;
  sourceQuarantineRows?: number;
  summaryOverride?: unknown;
  manifestTransform?: (manifest: FnsExactPlanManifest) => FnsExactPlanManifest;
  createInsertsArtifact?: boolean;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function makeSummary(expected: FnsExactPlanManifest['expected']): unknown {
  return {
    dryRunOnly: true,
    mode: 'existing-only-exact-okved-ogrn-first',
    source: {
      archive: OFFICIAL_ARCHIVE,
      xsd: OFFICIAL_XSD,
    },
    target: CURRENT_TARGET,
    combined: expected,
    idempotencyCheck: {
      repeatedUpdates: 0,
      passed: true,
    },
  };
}

async function writeFixture(options: FixtureOptions = {}) {
  const planDir = await mkdtemp(join(tmpdir(), 'fns-exact-plan-test-'));
  tempDirs.push(planDir);

  const updatesText = options.updatesText ?? jsonl([UPDATE]);
  const conflictsText = options.conflictsText ?? jsonl([CONFLICT]);
  const skippedText = options.skippedText ?? jsonl([SKIPPED]);
  const sourceQuarantineText = options.sourceQuarantineText
    ?? jsonl([SOURCE_QUARANTINE]);
  const updateCount = options.updateRows ?? 1;
  const conflictCount = options.conflictRows ?? 1;
  const matchedCount = updateCount + conflictCount;
  const expected: FnsExactPlanManifest['expected'] = {
    registry_rows: 3,
    unique_registry_ogrns: 3,
    unique_registry_inns: 3,
    matched_directory_rows: matchedCount,
    unique_matched_inns: 2,
    matched_by_ogrn_rows: matchedCount,
    matched_by_unique_inn_rows: 0,
    updates: updateCount,
    conflicts: conflictCount,
    skipped: options.skippedRows ?? 1,
    source_quarantined: options.sourceQuarantineRows ?? 1,
    noops: 0,
    inserts: 0,
  };
  const summary = options.summaryOverride ?? makeSummary(expected);
  const summaryText = `${JSON.stringify(summary)}\n`;
  const baseManifest: FnsExactPlanManifest = {
    version: 2,
    plan: 'fns-exact-okved-2026-07-10-v2',
    source: {
      archive: OFFICIAL_ARCHIVE,
      xsd: OFFICIAL_XSD,
    },
    target: CURRENT_TARGET,
    artifacts: {
      'summary.json': {
        sha256: hash(summaryText),
      },
      'updates.jsonl': {
        sha256: hash(updatesText),
        rows: expected.updates,
      },
      'conflicts.jsonl': {
        sha256: hash(conflictsText),
        rows: expected.conflicts,
      },
      'skipped.jsonl': {
        sha256: hash(skippedText),
        rows: expected.skipped,
      },
      'source-quarantine.jsonl': {
        sha256: hash(sourceQuarantineText),
        rows: expected.source_quarantined,
      },
    },
    expected,
  };
  const manifest = options.manifestTransform?.(baseManifest) ?? baseManifest;
  const manifestPath = join(planDir, 'manifest.json');

  await Promise.all([
    writeFile(join(planDir, 'summary.json'), summaryText),
    writeFile(join(planDir, 'updates.jsonl'), updatesText),
    writeFile(join(planDir, 'conflicts.jsonl'), conflictsText),
    writeFile(join(planDir, 'skipped.jsonl'), skippedText),
    writeFile(
      join(planDir, 'source-quarantine.jsonl'),
      sourceQuarantineText,
    ),
    writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
    ...(options.createInsertsArtifact
      ? [writeFile(join(planDir, 'inserts.jsonl'), '')]
      : []),
  ]);

  return {
    planDir,
    manifestPath,
    manifest,
    summary,
    texts: {
      'summary.json': summaryText,
      'updates.jsonl': updatesText,
      'conflicts.jsonl': conflictsText,
      'skipped.jsonl': skippedText,
      'source-quarantine.jsonl': sourceQuarantineText,
    },
  };
}

function validationInput(
  manifest: FnsExactPlanManifest,
  summary: unknown,
  texts: Record<string, string>,
) {
  return {
    manifest,
    summary,
    artifactHashes: Object.fromEntries(
      Object.entries(texts).map(([name, text]) => [name, hash(text)]),
    ),
    artifactRows: {
      'updates.jsonl': manifest.artifacts['updates.jsonl'].rows,
      'conflicts.jsonl': manifest.artifacts['conflicts.jsonl'].rows,
      'skipped.jsonl': manifest.artifacts['skipped.jsonl'].rows,
      'source-quarantine.jsonl':
        manifest.artifacts['source-quarantine.jsonl'].rows,
    },
  };
}

describe('FNS exact OKVED frozen plan files', () => {
  it('pins the official archive, XSD, current production target, artifacts, and deterministic fingerprint', async () => {
    const fixture = await writeFixture();
    const input = validationInput(
      fixture.manifest,
      fixture.summary,
      fixture.texts,
    );
    const reversedTopLevelKeys = Object.fromEntries(
      Object.entries(fixture.manifest).reverse(),
    ) as unknown as FnsExactPlanManifest;

    expect(fixture.manifest.source).toEqual({
      archive: OFFICIAL_ARCHIVE,
      xsd: OFFICIAL_XSD,
    });
    expect(fixture.manifest.target).toEqual(CURRENT_TARGET);
    expect(Object.keys(fixture.manifest.artifacts).sort()).toEqual([
      'conflicts.jsonl',
      'skipped.jsonl',
      'source-quarantine.jsonl',
      'summary.json',
      'updates.jsonl',
    ]);
    expect(validateFnsExactPlanManifest(input).planFingerprint).toBe(
      buildFnsExactPlanFingerprint(fixture.manifest),
    );
    expect(buildFnsExactPlanFingerprint(reversedTopLevelKeys)).toBe(
      buildFnsExactPlanFingerprint(fixture.manifest),
    );
    expect(
      buildFnsExactPlanFingerprint({
        ...fixture.manifest,
        plan: 'fns-exact-okved-changed',
      }),
    ).not.toBe(buildFnsExactPlanFingerprint(fixture.manifest));
    expect(buildFnsExactPlanFingerprint(fixture.manifest)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it.each([
    [
      'archive URL',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          archive: {
            ...manifest.source.archive,
            url: 'https://example.com/untrusted.zip',
          },
        },
      }),
    ],
    [
      'archive date',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          archive: {
            ...manifest.source.archive,
            release_date: '10.07.2026',
          },
        },
      }),
    ],
    [
      'archive bytes',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          archive: {
            ...manifest.source.archive,
            bytes: 0,
          },
        },
      }),
    ],
    [
      'archive SHA',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          archive: {
            ...manifest.source.archive,
            sha256: 'not-a-sha',
          },
        },
      }),
    ],
    [
      'XSD version',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          xsd: {
            ...manifest.source.xsd,
            version: '',
          },
        },
      }),
    ],
    [
      'XSD SHA',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          xsd: {
            ...manifest.source.xsd,
            sha256: '0',
          },
        },
      }),
    ],
    [
      'former production target',
      (manifest: FnsExactPlanManifest) => ({
        ...manifest,
        target: {
          ...manifest.target,
          host: '144.31.54.166',
        },
      }),
    ],
  ])('rejects invalid pinned metadata: %s', async (_label, mutate) => {
    const fixture = await writeFixture();
    const mutatedMetadata = mutate(fixture.manifest);
    const mutatedSummary = {
      ...(fixture.summary as Record<string, unknown>),
      source: mutatedMetadata.source,
      target: mutatedMetadata.target,
    };
    const mutatedSummaryText = `${JSON.stringify(mutatedSummary)}\n`;
    const mutated = {
      ...mutatedMetadata,
      artifacts: {
        ...mutatedMetadata.artifacts,
        'summary.json': {
          sha256: hash(mutatedSummaryText),
        },
      },
    };

    expect(() =>
      validateFnsExactPlanManifest(
        validationInput(mutated, mutatedSummary, {
          ...fixture.texts,
          'summary.json': mutatedSummaryText,
        }),
      )
    ).toThrow();
  });

  it('strictly validates update, conflict, skipped, and source-quarantine rows', () => {
    expect(validateFnsExactUpdateRow(UPDATE)).toEqual(UPDATE);
    expect(validateFnsExactConflictRow(CONFLICT)).toEqual(CONFLICT);
    expect(validateFnsExactSkippedRow(SKIPPED)).toEqual(SKIPPED);
    expect(validateFnsExactSourceQuarantineRow(SOURCE_QUARANTINE)).toEqual(SOURCE_QUARANTINE);

    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        inn: '1234567890',
      })
    ).toThrow(/INN/i);
    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        expected_ogrn: '1177746494177',
      })
    ).toThrow(/OGRN|match|identity/i);
    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        fns_ogrn: '1177746494167',
      })
    ).toThrow(/OGRN|checksum/i);
    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        match_method: 'unique_inn_fallback',
      })
    ).toThrow(/OGRN|fallback|match/i);
    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        okved_code_exact: '62.020',
      })
    ).toThrow(/OKVED/i);
    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        okved_exact_source: 'dadata',
      })
    ).toThrow(/source/i);
    expect(() =>
      validateFnsExactUpdateRow({
        ...UPDATE,
        unexpected: true,
      })
    ).toThrow(/field|unexpected/i);
    expect(() =>
      validateFnsExactConflictRow({
        ...CONFLICT,
        incoming_okved_exact_source: 'dadata',
      })
    ).toThrow(/source/i);
    expect(() =>
      validateFnsExactSkippedRow({
        ...SKIPPED,
        id: null,
      })
    ).toThrow(/id/i);
    expect(() =>
      validateFnsExactSkippedRow({
        ...SKIPPED,
        extra: 'forbidden',
      })
    ).toThrow(/field|unexpected/i);
    expect(() =>
      validateFnsExactSourceQuarantineRow({
        ...SOURCE_QUARANTINE,
        ogrn: '1177746494166',
      })
    ).toThrow(/valid OGRN|checksum|quarantine/i);
    expect(() =>
      validateFnsExactSourceQuarantineRow({
        ...SOURCE_QUARANTINE,
        ogrn: '102710098006',
      })
    ).toThrow(/length|digits|OGRN/i);
    expect(() =>
      validateFnsExactSourceQuarantineRow({
        ...SOURCE_QUARANTINE,
        unexpected: true,
      })
    ).toThrow(/field|unexpected/i);
  });

  it('streams every JSONL artifact in bounded batches', async () => {
    const updates = [
      UPDATE,
      {
        ...UPDATE,
        id: '11',
        inn: '7729058675',
        expected_ogrn: null,
        fns_ogrn: '1177746494177',
        match_method: 'unique_inn_fallback',
        okved_code_exact: '62.09',
      },
      {
        ...UPDATE,
        id: '12',
        inn: '772138583200',
        expected_ogrn: '321213400000004',
        fns_ogrn: '321213400000004',
        okved_code_exact: '62.02.2',
      },
    ];
    const fixture = await writeFixture({
      updatesText: jsonl(updates),
      updateRows: 3,
    });
    const updateBatches: unknown[][] = [];
    const conflictBatches: unknown[][] = [];
    const skippedBatches: unknown[][] = [];
    const sourceQuarantineBatches: unknown[][] = [];

    const processed = await processFnsExactPlanFiles({
      planDir: fixture.planDir,
      manifestPath: fixture.manifestPath,
      batchSize: 2,
      onUpdateBatch: async (rows) => {
        updateBatches.push(rows);
      },
      onConflictBatch: async (rows) => {
        conflictBatches.push(rows);
      },
      onSkippedBatch: async (rows) => {
        skippedBatches.push(rows);
      },
      onSourceQuarantineBatch: async (rows) => {
        sourceQuarantineBatches.push(rows);
      },
    });

    expect(processed).toMatchObject({
      planFingerprint: buildFnsExactPlanFingerprint(fixture.manifest),
      updateRows: 3,
      conflictRows: 1,
      skippedRows: 1,
      sourceQuarantinedRows: 1,
    });
    expect(updateBatches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(updateBatches.flat()).toEqual(updates);
    expect(conflictBatches).toEqual([[CONFLICT]]);
    expect(skippedBatches).toEqual([[SKIPPED]]);
    expect(sourceQuarantineBatches).toEqual([[SOURCE_QUARANTINE]]);
  });

  it('rejects invalid JSON and a duplicate target id before accepting the plan', async () => {
    const invalidJson = await writeFixture({
      updatesText: '{"id":\n',
      updateRows: 1,
    });
    await expect(
      processFnsExactPlanFiles({
        planDir: invalidJson.planDir,
        manifestPath: invalidJson.manifestPath,
      }),
    ).rejects.toThrow(/JSON/i);

    const duplicate = await writeFixture({
      updatesText: jsonl([
        UPDATE,
        {
          ...UPDATE,
          inn: '7729058675',
          expected_ogrn: '1177746494177',
          fns_ogrn: '1177746494177',
        },
      ]),
      updateRows: 2,
    });
    await expect(
      processFnsExactPlanFiles({
        planDir: duplicate.planDir,
        manifestPath: duplicate.manifestPath,
      }),
    ).rejects.toThrow(/duplicate.*id/i);
  });

  it('rejects artifact SHA, row-count, and summary drift', async () => {
    const fixture = await writeFixture();
    const valid = validationInput(
      fixture.manifest,
      fixture.summary,
      fixture.texts,
    );

    expect(() =>
      validateFnsExactPlanManifest({
        ...valid,
        artifactHashes: {
          ...valid.artifactHashes,
          'updates.jsonl': '0'.repeat(64),
        },
      })
    ).toThrow(/updates\.jsonl|SHA/i);
    expect(() =>
      validateFnsExactPlanManifest({
        ...valid,
        artifactRows: {
          ...valid.artifactRows,
          'conflicts.jsonl': 2,
        },
      })
    ).toThrow(/conflicts\.jsonl|row count/i);
    const driftedSummary = {
      ...(fixture.summary as Record<string, unknown>),
      combined: {
        ...fixture.manifest.expected,
        updates: 2,
      },
    };
    const driftedSummaryText = `${JSON.stringify(driftedSummary)}\n`;
    const driftedManifest = {
      ...fixture.manifest,
      artifacts: {
        ...fixture.manifest.artifacts,
        'summary.json': {
          sha256: hash(driftedSummaryText),
        },
      },
    };
    expect(() =>
      validateFnsExactPlanManifest({
        ...validationInput(
          driftedManifest,
          driftedSummary,
          {
            ...fixture.texts,
            'summary.json': driftedSummaryText,
          },
        ),
      })
    ).toThrow(/summary|count|updates/i);
  });

  it('re-reads and re-hashes artifacts on every staging pass', async () => {
    const fixture = await writeFixture();

    await expect(
      processFnsExactPlanFiles({
        planDir: fixture.planDir,
        manifestPath: fixture.manifestPath,
      }),
    ).resolves.toMatchObject({ updateRows: 1 });

    await writeFile(
      join(fixture.planDir, 'updates.jsonl'),
      jsonl([
        {
          ...UPDATE,
          okved_code_exact: '62.02',
        },
      ]),
    );

    const staged: unknown[][] = [];
    await expect(
      processFnsExactPlanFiles({
        planDir: fixture.planDir,
        manifestPath: fixture.manifestPath,
        onUpdateBatch: async (rows) => {
          staged.push(rows);
        },
      }),
    ).rejects.toThrow(/updates\.jsonl|SHA/i);
  });

  it('rejects both a declared and an undeclared inserts artifact', async () => {
    const declared = await writeFixture({
      manifestTransform: (manifest) => ({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          'inserts.jsonl': {
            sha256: hash(''),
            rows: 0,
          },
        },
      } as unknown as FnsExactPlanManifest),
    });
    expect(() =>
      validateFnsExactPlanManifest(
        validationInput(
          declared.manifest,
          declared.summary,
          declared.texts,
        ),
      )
    ).toThrow(/insert|artifact/i);

    const undeclared = await writeFixture({
      createInsertsArtifact: true,
    });
    await expect(
      processFnsExactPlanFiles({
        planDir: undeclared.planDir,
        manifestPath: undeclared.manifestPath,
      }),
    ).rejects.toThrow(/insert|unexpected artifact/i);
  });
});
