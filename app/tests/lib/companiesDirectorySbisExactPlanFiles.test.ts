/** @jest-environment node */

import { createHash } from 'node:crypto';
import {
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSbisExactPlanFingerprint,
  processSbisExactPlanFiles,
  validateSbisExactPlanManifest,
  type SbisExactPlanManifest,
} from '@/lib/companiesDirectory/sbisExactPlanFiles';

const SBIS_SOURCE = 'sbis_registry';
const PLAN = 'sbis-exact-okved-v1';
const CURRENT_TARGET = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'companies_directory',
};
const PINNED_SOURCE = {
  id: SBIS_SOURCE,
  analysis: {
    file_name: 'registry-exact-source-analysis.json',
    sha256: '351ac4660cc0242e453ed8f0ce1c7ce415fb165441c8b2a67c73c11d922028d7',
    candidates: 134_199,
  },
  locations: {
    file_name: 'source-locations.jsonl',
    sha256: '55526b74173593d752f57609d98ede0a14d359b038cbd8005bf4c787bbc0f526',
    rows: 160_028,
  },
  registry_manifest: {
    file_name: 'polza-registry-v2.manifest.json',
    sha256: 'b3688f8c511349f86d1075fad46e25def272e835e04388239a56c36468d64a8e',
  },
};
const PINNED_REFERENCE = {
  count: 2_680,
  md5: '83d8fe43ba6c52b8e11024258a467783',
};
const PINNED_SNAPSHOT = {
  file_name: 'sbis-exact-target-snapshot-20260813.jsonl.gz',
  sha256: 'c'.repeat(64),
  candidate_rows: 134_199,
  target_rows: 146_471,
  exported_at: '2026-08-13T18:45:00.000Z',
  target: CURRENT_TARGET,
};

const LEGAL_INN_A = '7704414297';
const LEGAL_INN_B = '7729058675';
const LEGAL_INN_C = '7107064151';
const LEGAL_OGRN_A = '1177746494166';
const LEGAL_OGRN_B = '1177746494177';
const LEGAL_OGRN_C = '1027100980060';
const SOURCE_SHA_A = 'a'.repeat(64);
const SOURCE_SHA_B = 'b'.repeat(64);

const UPDATE = {
  id: '10',
  inn: LEGAL_INN_A,
  expected_ogrn: LEGAL_OGRN_A,
  registry_ogrn: LEGAL_OGRN_A,
  match_method: 'ogrn_inn',
  okved_code_exact: '62.01',
  okved_exact_source: SBIS_SOURCE,
};
const NOOP = {
  id: '11',
  inn: LEGAL_INN_B,
  expected_ogrn: LEGAL_OGRN_B,
  registry_ogrn: LEGAL_OGRN_B,
  match_method: 'ogrn_inn',
  reason: 'already_exact',
};
const CONFLICT = {
  id: '12',
  inn: LEGAL_INN_C,
  expected_ogrn: LEGAL_OGRN_C,
  registry_ogrn: LEGAL_OGRN_C,
  match_method: 'ogrn_inn',
  kind: 'existing_exact_preserved',
  existing_okved_code_exact: '62.02',
  existing_okved_exact_source: 'dadata',
  incoming_okved_code_exact: '62.01',
  incoming_okved_exact_source: SBIS_SOURCE,
};
const SKIPPED = {
  inn: '212401514249',
  registry_ogrn: '322890100023953',
  reason: 'target_identity_not_found',
};
const SOURCE_QUARANTINE = {
  inn: LEGAL_INN_A,
  ogrn: LEGAL_OGRN_A,
  reason: 'conflicting_source_okved',
  okved_codes: ['62.01', '62.02'],
  sources: [
    {
      source_file: 'LEGAL77.csv.zip',
      sha256: SOURCE_SHA_A,
      rowNumbers: [2],
    },
    {
      source_file: 'WIRUJA.csv',
      sha256: SOURCE_SHA_B,
      rowNumbers: [8],
    },
  ],
};
const PROVENANCE = {
  action: 'update',
  id: UPDATE.id,
  inn: UPDATE.inn,
  ogrn: UPDATE.registry_ogrn,
  okved_code_exact: UPDATE.okved_code_exact,
  sources: [
    {
      source_file: 'LEGAL77.csv.zip',
      sha256: SOURCE_SHA_A,
      rowNumbers: [2],
    },
  ],
};
const ROLLBACK = {
  action: 'restore_exact',
  id: UPDATE.id,
  inn: UPDATE.inn,
  expected_ogrn: UPDATE.expected_ogrn,
  okved_code_exact: null,
  okved_exact_source: null,
};

const ARTIFACT_NAMES = [
  'summary.json',
  'updates.jsonl',
  'noops.jsonl',
  'conflicts.jsonl',
  'skipped.jsonl',
  'source-quarantine.jsonl',
  'provenance.jsonl',
  'rollback.jsonl',
] as const;
type ArtifactName = typeof ARTIFACT_NAMES[number];
type JsonlArtifactName = Exclude<ArtifactName, 'summary.json'>;

interface FixtureOptions {
  rows?: Partial<Record<JsonlArtifactName, unknown[]>>;
  manifestTransform?: (
    manifest: SbisExactPlanManifest,
  ) => SbisExactPlanManifest;
  summaryTransform?: (
    summary: Record<string, unknown>,
  ) => Record<string, unknown>;
  extraFiles?: Record<string, string>;
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

function jsonl(rows: readonly unknown[]): string {
  return rows.length === 0
    ? ''
    : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function expectedApplyUpdate<T extends { registry_ogrn: string }>(
  row: T,
): Omit<T, 'registry_ogrn'> & { fns_ogrn: string } {
  const { registry_ogrn: registryOgrn, ...rest } = row;
  return {
    ...rest,
    fns_ogrn: registryOgrn,
  };
}

function artifactRows(options: FixtureOptions): Record<JsonlArtifactName, unknown[]> {
  return {
    'updates.jsonl': options.rows?.['updates.jsonl'] ?? [UPDATE],
    'noops.jsonl': options.rows?.['noops.jsonl'] ?? [NOOP],
    'conflicts.jsonl': options.rows?.['conflicts.jsonl'] ?? [CONFLICT],
    'skipped.jsonl': options.rows?.['skipped.jsonl'] ?? [SKIPPED],
    'source-quarantine.jsonl':
      options.rows?.['source-quarantine.jsonl'] ?? [SOURCE_QUARANTINE],
    'provenance.jsonl': options.rows?.['provenance.jsonl'] ?? [PROVENANCE],
    'rollback.jsonl': options.rows?.['rollback.jsonl'] ?? [ROLLBACK],
  };
}

async function writeFixture(options: FixtureOptions = {}) {
  const planDir = await mkdtemp(join(tmpdir(), 'sbis-exact-plan-files-'));
  tempDirs.push(planDir);

  const rows = artifactRows(options);
  const expected = {
    source_rows: 6,
    unique_source_identities: 5,
    matched_directory_rows:
      rows['updates.jsonl'].length
      + rows['noops.jsonl'].length
      + rows['conflicts.jsonl'].length,
    updates: rows['updates.jsonl'].length,
    noops: rows['noops.jsonl'].length,
    conflicts: rows['conflicts.jsonl'].length,
    skipped: rows['skipped.jsonl'].length,
    source_quarantined: rows['source-quarantine.jsonl'].length,
    provenance: rows['provenance.jsonl'].length,
    rollback: rows['rollback.jsonl'].length,
    inserts: 0 as const,
  };
  const baseSummary = {
    dryRunOnly: true,
    mode: 'existing-only-exact-okved-strict-inn-ogrn',
    source: PINNED_SOURCE,
    reference: PINNED_REFERENCE,
    snapshot: PINNED_SNAPSHOT,
    target: CURRENT_TARGET,
    combined: expected,
    idempotencyCheck: {
      repeatedUpdates: 0,
      passed: true,
    },
  };
  const summary = options.summaryTransform?.(baseSummary) ?? baseSummary;
  const texts = Object.fromEntries(
    Object.entries(rows).map(([name, artifact]) => [name, jsonl(artifact)]),
  ) as Record<JsonlArtifactName, string>;
  const summaryText = `${JSON.stringify(summary)}\n`;
  const baseManifest = {
    version: 1,
    plan: PLAN,
    source: PINNED_SOURCE,
    reference: PINNED_REFERENCE,
    snapshot: PINNED_SNAPSHOT,
    target: CURRENT_TARGET,
    artifacts: {
      'summary.json': { sha256: hash(summaryText) },
      ...Object.fromEntries(
        Object.entries(texts).map(([name, text]) => [
          name,
          {
            sha256: hash(text),
            rows: rows[name as JsonlArtifactName].length,
          },
        ]),
      ),
    },
    expected,
  } as SbisExactPlanManifest;
  const manifest = options.manifestTransform?.(baseManifest) ?? baseManifest;
  const manifestPath = join(planDir, 'manifest.json');

  await Promise.all([
    writeFile(join(planDir, 'summary.json'), summaryText),
    ...Object.entries(texts).map(([name, text]) =>
      writeFile(join(planDir, name), text)
    ),
    writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
    ...Object.entries(options.extraFiles ?? {}).map(([name, text]) =>
      writeFile(join(planDir, name), text)
    ),
  ]);

  return {
    planDir,
    manifestPath,
    manifest,
    summary,
    summaryText,
    rows,
    texts,
  };
}

function validationInput(fixture: Awaited<ReturnType<typeof writeFixture>>) {
  return {
    manifest: fixture.manifest,
    summary: fixture.summary,
    artifactHashes: {
      'summary.json': hash(fixture.summaryText),
      ...Object.fromEntries(
        Object.entries(fixture.texts).map(([name, text]) => [name, hash(text)]),
      ),
    },
    artifactRows: Object.fromEntries(
      Object.entries(fixture.rows).map(([name, rows]) => [name, rows.length]),
    ),
  };
}

describe('SBIS exact OKVED frozen plan files', () => {
  it('pins the exact artifact set, row counts, hashes, source, target, and no-insert contract', async () => {
    const fixture = await writeFixture();
    const validated = validateSbisExactPlanManifest(validationInput(fixture));

    expect(fixture.manifest.source).toEqual(PINNED_SOURCE);
    expect(fixture.manifest.reference).toEqual(PINNED_REFERENCE);
    expect(fixture.manifest.snapshot).toEqual(PINNED_SNAPSHOT);
    expect(fixture.manifest.target).toEqual(CURRENT_TARGET);
    expect(fixture.manifest.expected.inserts).toBe(0);
    expect(Object.keys(fixture.manifest.artifacts).sort()).toEqual(
      [...ARTIFACT_NAMES].sort(),
    );
    expect(validated.planFingerprint).toBe(
      buildSbisExactPlanFingerprint(fixture.manifest),
    );
    expect(validated.planFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const reversed = Object.fromEntries(
      Object.entries(fixture.manifest).reverse(),
    ) as unknown as SbisExactPlanManifest;
    expect(buildSbisExactPlanFingerprint(reversed)).toBe(
      buildSbisExactPlanFingerprint(fixture.manifest),
    );
  });

  it('streams all declared artifacts and maps registry_ogrn to fns_ogrn only for the apply callback', async () => {
    const secondUpdate = {
      ...UPDATE,
      id: '13',
      inn: '772138583200',
      expected_ogrn: '321213400000004',
      registry_ogrn: '321213400000004',
      okved_code_exact: '62.02',
    };
    const fixture = await writeFixture({
      rows: {
        'updates.jsonl': [UPDATE, secondUpdate],
      },
    });
    const updateBatches: unknown[][] = [];
    const noopBatches: unknown[][] = [];
    const conflictBatches: unknown[][] = [];
    const skippedBatches: unknown[][] = [];
    const quarantineBatches: unknown[][] = [];
    const provenanceBatches: unknown[][] = [];
    const rollbackBatches: unknown[][] = [];

    const processed = await processSbisExactPlanFiles({
      planDir: fixture.planDir,
      manifestPath: fixture.manifestPath,
      batchSize: 1,
      onUpdateBatch: async (rows) => updateBatches.push(rows),
      onNoopBatch: async (rows) => noopBatches.push(rows),
      onConflictBatch: async (rows) => conflictBatches.push(rows),
      onSkippedBatch: async (rows) => skippedBatches.push(rows),
      onSourceQuarantineBatch: async (rows) => quarantineBatches.push(rows),
      onProvenanceBatch: async (rows) => provenanceBatches.push(rows),
      onRollbackBatch: async (rows) => rollbackBatches.push(rows),
    });

    expect(processed).toMatchObject({
      planFingerprint: buildSbisExactPlanFingerprint(fixture.manifest),
      updateRows: 2,
      noopRows: 1,
      conflictRows: 1,
      skippedRows: 1,
      sourceQuarantinedRows: 1,
      provenanceRows: 1,
      rollbackRows: 1,
    });
    expect(updateBatches).toEqual([
      [expectedApplyUpdate(UPDATE)],
      [expectedApplyUpdate(secondUpdate)],
    ]);
    expect(noopBatches).toEqual([[NOOP]]);
    expect(conflictBatches).toEqual([[CONFLICT]]);
    expect(skippedBatches).toEqual([[SKIPPED]]);
    expect(quarantineBatches).toEqual([[SOURCE_QUARANTINE]]);
    expect(provenanceBatches).toEqual([[PROVENANCE]]);
    expect(rollbackBatches).toEqual([[ROLLBACK]]);
  });

  it('rejects a missing, unknown, or tampered artifact before invoking apply callbacks', async () => {
    const missing = await writeFixture();
    await unlink(join(missing.planDir, 'rollback.jsonl'));
    await expect(processSbisExactPlanFiles({
      planDir: missing.planDir,
      manifestPath: missing.manifestPath,
    })).rejects.toThrow(/rollback|missing|ENOENT/i);

    const unknown = await writeFixture({
      extraFiles: {
        'inserts.jsonl': '',
      },
    });
    await expect(processSbisExactPlanFiles({
      planDir: unknown.planDir,
      manifestPath: unknown.manifestPath,
    })).rejects.toThrow(/insert|unexpected|unknown artifact/i);

    const tampered = await writeFixture();
    await writeFile(
      join(tampered.planDir, 'updates.jsonl'),
      jsonl([{ ...UPDATE, okved_code_exact: '62.02' }]),
    );
    const staged: unknown[][] = [];
    await expect(processSbisExactPlanFiles({
      planDir: tampered.planDir,
      manifestPath: tampered.manifestPath,
      onUpdateBatch: async (rows) => staged.push(rows),
    })).rejects.toThrow(/updates\.jsonl|SHA|hash/i);
    expect(staged).toEqual([]);
  });

  it('rejects missing or unknown manifest artifacts and all declared/undeclared insert artifacts', async () => {
    const missing = await writeFixture({
      manifestTransform: (manifest) => {
        const artifacts = { ...manifest.artifacts } as Record<string, unknown>;
        delete artifacts['provenance.jsonl'];
        return { ...manifest, artifacts } as SbisExactPlanManifest;
      },
    });
    expect(() => validateSbisExactPlanManifest(validationInput(missing))).toThrow(
      /provenance|missing|artifact/i,
    );

    const unknown = await writeFixture({
      manifestTransform: (manifest) => ({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          'notes.jsonl': {
            sha256: hash(''),
            rows: 0,
          },
        },
      } as unknown as SbisExactPlanManifest),
    });
    expect(() => validateSbisExactPlanManifest(validationInput(unknown))).toThrow(
      /notes|unknown|unexpected artifact/i,
    );

    const declaredInsert = await writeFixture({
      manifestTransform: (manifest) => ({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          'inserts.jsonl': {
            sha256: hash(''),
            rows: 0,
          },
        },
      } as unknown as SbisExactPlanManifest),
    });
    expect(() =>
      validateSbisExactPlanManifest(validationInput(declaredInsert))
    ).toThrow(/insert|artifact/i);
  });

  it('rejects hash, row-count, summary, source, and no-insert drift', async () => {
    const fixture = await writeFixture();
    const valid = validationInput(fixture);

    expect(() => validateSbisExactPlanManifest({
      ...valid,
      artifactHashes: {
        ...valid.artifactHashes,
        'provenance.jsonl': '0'.repeat(64),
      },
    })).toThrow(/provenance\.jsonl|SHA|hash/i);
    expect(() => validateSbisExactPlanManifest({
      ...valid,
      artifactRows: {
        ...valid.artifactRows,
        'rollback.jsonl': 2,
      },
    })).toThrow(/rollback\.jsonl|row count/i);

    const summaryDrift = await writeFixture({
      summaryTransform: (summary) => ({
        ...summary,
        combined: {
          ...(summary.combined as Record<string, unknown>),
          updates: 2,
        },
      }),
    });
    expect(() =>
      validateSbisExactPlanManifest(validationInput(summaryDrift))
    ).toThrow(/summary|updates|count/i);

    const manifestSourceMismatch = await writeFixture({
      manifestTransform: (manifest) => ({
        ...manifest,
        source: {
          ...manifest.source,
          id: 'fns_sme_registry',
        },
      } as unknown as SbisExactPlanManifest),
    });
    expect(() =>
      validateSbisExactPlanManifest(validationInput(manifestSourceMismatch))
    ).toThrow(/source|sbis_registry/i);

    const summarySourceMismatch = await writeFixture({
      summaryTransform: (summary) => ({
        ...summary,
        source: {
          ...PINNED_SOURCE,
          analysis: {
            ...PINNED_SOURCE.analysis,
            sha256: 'd'.repeat(64),
          },
        },
      }),
    });
    expect(() =>
      validateSbisExactPlanManifest(validationInput(summarySourceMismatch))
    ).toThrow(/summary|source|sbis_registry/i);

    const insertsMismatch = await writeFixture({
      manifestTransform: (manifest) => ({
        ...manifest,
        expected: {
          ...manifest.expected,
          inserts: 1,
        },
      } as unknown as SbisExactPlanManifest),
    });
    expect(() =>
      validateSbisExactPlanManifest(validationInput(insertsMismatch))
    ).toThrow(/insert/i);
  });

  it.each([
    ['analysis hash', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      source: {
        ...manifest.source,
        analysis: {
          ...manifest.source.analysis,
          sha256: '0'.repeat(64),
        },
      },
    })],
    ['analysis candidates', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      source: {
        ...manifest.source,
        analysis: {
          ...manifest.source.analysis,
          candidates: 134_198,
        },
      },
    })],
    ['locations rows', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      source: {
        ...manifest.source,
        locations: {
          ...manifest.source.locations,
          rows: 160_027,
        },
      },
    })],
    ['registry manifest hash', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      source: {
        ...manifest.source,
        registry_manifest: {
          ...manifest.source.registry_manifest,
          sha256: '0'.repeat(64),
        },
      },
    })],
    ['reference digest', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      reference: {
        ...manifest.reference,
        md5: '0'.repeat(32),
      },
    })],
    ['snapshot target', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      snapshot: {
        ...manifest.snapshot,
        target: {
          ...manifest.snapshot.target,
          host: '144.31.54.166',
        },
      },
    })],
    ['snapshot timestamp', (manifest: SbisExactPlanManifest) => ({
      ...manifest,
      snapshot: {
        ...manifest.snapshot,
        exported_at: 'not-a-date',
      },
    })],
  ])('rejects pinned metadata drift: %s', async (_label, mutate) => {
    const fixture = await writeFixture({
      manifestTransform: mutate as (
        manifest: SbisExactPlanManifest,
      ) => SbisExactPlanManifest,
    });
    expect(() =>
      validateSbisExactPlanManifest(validationInput(fixture))
    ).toThrow(/source|analysis|location|manifest|reference|snapshot|target|hash|count|date/i);
  });

  it('rejects a duplicate target id across decision artifacts and an update row source mismatch', async () => {
    const duplicateTarget = await writeFixture({
      rows: {
        'noops.jsonl': [{
          ...NOOP,
          id: UPDATE.id,
        }],
      },
    });
    await expect(processSbisExactPlanFiles({
      planDir: duplicateTarget.planDir,
      manifestPath: duplicateTarget.manifestPath,
    })).rejects.toThrow(/duplicate.*(?:target|id)|target.*duplicate/i);

    const mismatchedSource = await writeFixture({
      rows: {
        'updates.jsonl': [{
          ...UPDATE,
          okved_exact_source: 'dadata',
        }],
      },
    });
    await expect(processSbisExactPlanFiles({
      planDir: mismatchedSource.planDir,
      manifestPath: mismatchedSource.manifestPath,
    })).rejects.toThrow(/source|sbis_registry/i);
  });
});
