import {
  normalizeStrictEmailList,
  normalizeStrictRussianPhoneList,
  normalizeStrictWebsiteList,
} from '@/lib/companiesDirectory/contactPolicy';
import type {
  RegistryV2FilteredStatus,
  RegistryV2Schema,
} from '@/lib/companiesDirectory/registryCsvArchive';
import {
  applySbisImportPlan,
  buildStrictSbisContactImportPlanV2,
  normalizeSbisInn,
  type ExistingDirectoryRow,
  type NormalizedSbisCompany,
  type SbisDirectoryInputRow,
  type SbisImportPlan,
} from '@/lib/companiesDirectory/sbisImportPlan';

export interface RegistryV2PlanSource {
  sourceFile: string;
  sourceSha256: string;
  csvSha256: string | null;
  entryName: string | null;
  schema: RegistryV2Schema | null;
  inputRows: number;
  activeRows: SbisDirectoryInputRow[];
  filteredStatuses: RegistryV2FilteredStatus[];
  sourceBytes?: number;
  uncompressedBytes?: number;
  error?: string;
}

export interface RegistryV2PlanSourceManifest {
  sourceFile: string;
  sha256: string;
  inputRows: number;
  uniqueInns: number;
}

export interface RegistryV2PlanBundle {
  plan: SbisImportPlan;
  manifestSources: RegistryV2PlanSourceManifest[];
  sourceArchives: Array<Record<string, unknown>>;
  filteredStatuses: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
  sourceLocations: Array<Record<string, unknown>>;
  rollback: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
}

type ContactField = 'email' | 'website' | 'phones';

interface AcceptedSource {
  source: RegistryV2PlanSource;
  activeRows: SbisDirectoryInputRow[];
}

interface RowOrigin {
  sourceFile: string;
  sourceRowNumber: number;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'ru-RU');
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function assertSourceDescriptor(source: RegistryV2PlanSource): void {
  if (!Number.isSafeInteger(source.inputRows) || source.inputRows < 0) {
    throw new Error(`${source.sourceFile} descriptor has invalid inputRows`);
  }

  if (source.error !== undefined) {
    if (
      source.error !== 'empty_archive'
      || source.csvSha256 !== null
      || source.entryName !== null
      || source.schema !== null
      || source.inputRows !== 0
      || source.activeRows.length !== 0
      || source.filteredStatuses.length !== 0
    ) {
      throw new Error(`${source.sourceFile} descriptor contains an invalid source error`);
    }
    return;
  }

  if (
    source.csvSha256 === null
    || typeof source.entryName !== 'string'
    || !source.entryName.trim()
    || !['legal-entity', 'entrepreneur'].includes(String(source.schema))
  ) {
    throw new Error(`${source.sourceFile} descriptor has no valid CSV schema`);
  }
  if (
    source.inputRows
    !== source.activeRows.length + source.filteredStatuses.length
  ) {
    throw new Error(`${source.sourceFile} descriptor inputRows do not match parsed rows`);
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizedContactValues(
  field: ContactField,
  value: unknown,
): string[] {
  if (field === 'email') return normalizeStrictEmailList(String(value ?? ''));
  if (field === 'website') return normalizeStrictWebsiteList(String(value ?? ''));
  return normalizeStrictRussianPhoneList(String(value ?? ''));
}

function contactShape(
  rows: SbisImportPlan['inserts'],
): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const row of rows) {
    const key = [
      row.website ? 'website' : null,
      row.email ? 'email' : null,
      row.phones ? 'phone' : null,
    ].filter(Boolean).join('+');
    shape[key] = (shape[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(shape).sort(([left], [right]) => compareText(left, right)));
}

function countApproximateOkved(
  rows: SbisImportPlan['inserts'],
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = String(row.okved_code ?? '(не указан)');
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => compareText(left, right));
}

export function buildRegistryV2PlanBundle(
  inputSources: RegistryV2PlanSource[],
  existingRows: ExistingDirectoryRow[],
): RegistryV2PlanBundle {
  const sources = [...inputSources].sort((left, right) =>
    compareText(left.sourceFile, right.sourceFile)
  );
  const sourceNames = new Set<string>();
  const acceptedCsvByHash = new Map<string, string>();
  const acceptedSources: AcceptedSource[] = [];
  const sourceArchives: Array<Record<string, unknown>> = [];
  const manifestSources: RegistryV2PlanSourceManifest[] = [];

  for (const source of sources) {
    if (!source.sourceFile.trim() || sourceNames.has(source.sourceFile)) {
      throw new Error(`Registry v2 source name is empty or duplicated: ${source.sourceFile}`);
    }
    sourceNames.add(source.sourceFile);
    assertSha256(source.sourceSha256, `${source.sourceFile} source hash`);
    if (source.csvSha256 !== null) {
      assertSha256(source.csvSha256, `${source.sourceFile} CSV hash`);
    }
    assertSourceDescriptor(source);
    const duplicateOf = source.csvSha256
      ? acceptedCsvByHash.get(source.csvSha256.toLowerCase())
      : undefined;
    const status = !source.csvSha256
      ? 'empty_archive'
      : duplicateOf
        ? 'duplicate_csv'
        : 'accepted';
    if (status === 'accepted' && source.csvSha256) {
      acceptedCsvByHash.set(source.csvSha256.toLowerCase(), source.sourceFile);
      acceptedSources.push({ source, activeRows: source.activeRows });
    }

    const activeRows = status === 'accepted' ? source.activeRows : [];
    const uniqueInns = new Set(
      activeRows
        .map((row) => normalizeSbisInn(row.inn))
        .filter((inn): inn is string => Boolean(inn)),
    ).size;
    manifestSources.push({
      sourceFile: source.sourceFile,
      sha256: source.sourceSha256.toLowerCase(),
      inputRows: activeRows.length,
      uniqueInns,
    });
    sourceArchives.push({
      sourceFile: source.sourceFile,
      sourceSha256: source.sourceSha256.toLowerCase(),
      csvSha256: source.csvSha256?.toLowerCase() ?? null,
      entryName: source.entryName,
      schema: source.schema,
      status,
      duplicateOf: duplicateOf ?? null,
      sourceBytes: source.sourceBytes ?? null,
      uncompressedBytes: source.uncompressedBytes ?? null,
      inputRows: source.inputRows,
      activeRows: source.activeRows.length,
      filteredStatusRows: source.filteredStatuses.length,
      error: source.error ?? null,
    });
  }

  const rowOrigins = new Map<number, RowOrigin>();
  const rowSourcesByInn = new Map<string, Set<string>>();
  const fieldSourcesByInn = new Map<string, Map<ContactField, Set<string>>>();
  const locationsBySourceInn = new Map<string, {
    sourceFile: string;
    inn: string;
    rowNumbers: number[];
  }>();
  const globalInputs: SbisDirectoryInputRow[] = [];
  let nextRowNumber = 2;

  for (const { source, activeRows } of acceptedSources) {
    for (const input of activeRows) {
      const sourceRowNumber = input.rowNumber;
      const globalInput = { ...input, rowNumber: nextRowNumber };
      nextRowNumber += 1;
      globalInputs.push(globalInput);
      rowOrigins.set(globalInput.rowNumber, {
        sourceFile: source.sourceFile,
        sourceRowNumber,
      });
      const inn = normalizeSbisInn(globalInput.inn);
      if (!inn) continue;
      const sourceSet = rowSourcesByInn.get(inn) ?? new Set<string>();
      sourceSet.add(source.sourceFile);
      rowSourcesByInn.set(inn, sourceSet);

      const locationKey = `${source.sourceFile}\u0000${inn}`;
      const location = locationsBySourceInn.get(locationKey) ?? {
        sourceFile: source.sourceFile,
        inn,
        rowNumbers: [],
      };
      location.rowNumbers.push(sourceRowNumber);
      locationsBySourceInn.set(locationKey, location);

      const fields = fieldSourcesByInn.get(inn) ?? new Map<ContactField, Set<string>>();
      for (const field of ['email', 'website', 'phones'] as const) {
        if (normalizedContactValues(field, globalInput[field]).length === 0) continue;
        const fieldSources = fields.get(field) ?? new Set<string>();
        fieldSources.add(source.sourceFile);
        fields.set(field, fieldSources);
      }
      fieldSourcesByInn.set(inn, fields);
    }
  }

  const planOptions = {
    sourceFile: 'polza-registry-v2',
    sourceFileResolver: (company: NormalizedSbisCompany) => {
      const contributors = company.rowNumbers
        .map((rowNumber) => rowOrigins.get(rowNumber)?.sourceFile)
        .filter((name): name is string => Boolean(name));
      return sortedUnique(contributors).join(', ') || null;
    },
  };
  const plan = buildStrictSbisContactImportPlanV2(
    globalInputs,
    existingRows,
    planOptions,
  );
  const afterFirstPlan = applySbisImportPlan(existingRows, plan);
  const repeated = buildStrictSbisContactImportPlanV2(
    globalInputs,
    afterFirstPlan,
    planOptions,
  );

  const sourceByName = new Map(sources.map((source) => [source.sourceFile, source]));
  const sourceEvidence = (inn: string, sourceFiles: Iterable<string>) =>
    sortedUnique(sourceFiles).map((sourceFile) => ({
      source_file: sourceFile,
      sha256: sourceByName.get(sourceFile)?.sourceSha256.toLowerCase() ?? null,
      rowNumbers: locationsBySourceInn.get(`${sourceFile}\u0000${inn}`)?.rowNumbers ?? [],
    }));
  const provenance: Array<Record<string, unknown>> = [
    ...plan.inserts.map((insert) => ({
      action: 'insert',
      inn: insert.inn,
      sources: sourceEvidence(
        insert.inn,
        rowSourcesByInn.get(insert.inn) ?? [],
      ),
    })),
    ...plan.updates.map((update) => ({
      action: 'update',
      id: update.id,
      inn: update.inn,
      fields: Object.fromEntries(Object.keys(update.patch).sort(compareText).map((field) => [
        field,
        sourceEvidence(
          update.inn,
          fieldSourcesByInn.get(update.inn)?.get(field as ContactField)
            ?? rowSourcesByInn.get(update.inn)
            ?? [],
        ),
      ])),
    })),
  ];
  const sourceLocations = [...locationsBySourceInn.values()]
    .map((location) => ({
      source_file: location.sourceFile,
      source_sha256: sourceByName.get(location.sourceFile)?.sourceSha256.toLowerCase() ?? null,
      inn: location.inn,
      rowNumbers: [...location.rowNumbers].sort((left, right) => left - right),
    }))
    .sort((left, right) =>
      compareText(left.source_file, right.source_file) || compareText(left.inn, right.inn)
    );
  const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
  const rollback: Array<Record<string, unknown>> = [
    ...plan.inserts.map((insert) => ({
      action: 'delete_inserted',
      inn: insert.inn,
      expected_source_file: insert.source_file,
    })),
    ...plan.updates.map((update) => {
      const existing = existingById.get(String(update.id));
      if (!existing) throw new Error(`Missing before-image for update ${String(update.id)}`);
      return {
        action: 'restore_update',
        id: update.id,
        inn: update.inn,
        fields: Object.fromEntries(Object.keys(update.patch).sort(compareText).map((field) => [
          field,
          existing[field as keyof ExistingDirectoryRow] ?? null,
        ])),
      };
    }),
  ];
  const filteredStatuses = sources.flatMap((source) =>
    source.filteredStatuses.map((row) => ({
      source_file: source.sourceFile,
      rowNumber: row.rowNumber,
      inn: row.inn,
      status: row.status,
    })),
  );
  const approximateOkvedCounts = countApproximateOkved(plan.inserts);
  const uniqueIncomingInns = new Set(
    globalInputs
      .map((row) => normalizeSbisInn(row.inn))
      .filter((inn): inn is string => Boolean(inn)),
  ).size;
  const summary = {
    dryRunOnly: true,
    mode: 'registry-v2',
    input: {
      files: manifestSources.map((source) => ({ ...source })),
    },
    combined: {
      inputRows: globalInputs.length,
      uniqueIncomingInns,
      matchedSnapshotRows: existingRows.length,
      inserts: plan.inserts.length,
      updates: plan.updates.length,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.length,
      rejectedRows: plan.rejected.length,
      approximateOkvedCounts,
      contactShape: contactShape(plan.inserts),
      updateFields: {
        email: plan.updates.filter((row) => Boolean(row.patch.email)).length,
        website: plan.updates.filter((row) => Boolean(row.patch.website)).length,
        phones: plan.updates.filter((row) => Boolean(row.patch.phones)).length,
      },
      provenanceRecords: provenance.length,
      sourceLocationRecords: sourceLocations.length,
      rollbackRecords: rollback.length,
      sourceArchiveRecords: sourceArchives.length,
      filteredStatusRecords: filteredStatuses.length,
    },
    idempotencyCheck: {
      repeatedInserts: repeated.inserts.length,
      repeatedUpdates: repeated.updates.length,
      passed: repeated.inserts.length === 0 && repeated.updates.length === 0,
    },
  };

  return {
    plan,
    manifestSources,
    sourceArchives,
    filteredStatuses,
    provenance,
    sourceLocations,
    rollback,
    summary,
  };
}
