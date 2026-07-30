import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertSha256Hex,
  canonicalJson,
  isJsonObject,
  sha256Hex,
  type JsonObject,
} from '@/lib/companiesDirectory/guardedImportCore';
import {
  FNS_SME_EXACT_OKVED_SOURCE,
} from '@/lib/companiesDirectory/fnsExactPlan';
import {
  validateFnsInn,
  validateFnsOgrn,
  validateFnsOgrnStructure,
  validateFnsOkvedCode,
  validateFnsRegistryDate,
  validateFnsSmeZipEntryName,
  type FnsSmeTaxpayerType,
} from '@/lib/companiesDirectory/fnsSmeXml';
import {
  parseJsonValue,
  readJsonLines,
} from '@/lib/companiesDirectory/planFileIO';

export const FNS_EXACT_OFFICIAL_ARCHIVE = {
  url: 'https://file.nalog.ru/opendata/7707329152-rsmp/data-10072026-structure-12052026.zip',
  release_date: '2026-07-10',
  bytes: 2_111_054_656,
} as const;
export const FNS_EXACT_OFFICIAL_XSD = {
  file_name: 'structure-12052026.xsd',
  version: '12052026',
  sha256:
    '1d90729f30a3b6119f20db6ca34664034950ecacf86f9fae925ab60ce3cf3845',
} as const;
export const FNS_EXACT_CURRENT_TARGET = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'companies_directory',
} as const;
const POSTGRES_BIGINT_MAX = BigInt('9223372036854775807');
const ARTIFACT_NAMES = [
  'summary.json',
  'updates.jsonl',
  'conflicts.jsonl',
  'skipped.jsonl',
  'source-quarantine.jsonl',
] as const;

interface HashedArtifact {
  sha256: string;
}

interface JsonlArtifact extends HashedArtifact {
  rows: number;
}

export interface FnsExactPlanExpected {
  registry_rows: number;
  unique_registry_ogrns: number;
  unique_registry_inns: number;
  matched_directory_rows: number;
  unique_matched_inns: number;
  matched_by_ogrn_rows: number;
  matched_by_unique_inn_rows: number;
  updates: number;
  conflicts: number;
  skipped: number;
  source_quarantined: number;
  inserts: 0;
  noops: number;
}

export interface FnsExactPlanManifest {
  version: 2;
  plan: string;
  source: {
    archive: {
      url: string;
      release_date: string;
      bytes: number;
      sha256: string;
    };
    xsd: {
      file_name: string;
      version: string;
      sha256: string;
    };
    snapshot?: {
      version: 2;
      file_name: string;
      bytes: number;
      sha256: string;
      rows: number;
      exported_at: string;
    };
  };
  target: {
    host: string;
    port: number;
    database: string;
    table: string;
  };
  artifacts: {
    'summary.json': HashedArtifact;
    'updates.jsonl': JsonlArtifact;
    'conflicts.jsonl': JsonlArtifact;
    'skipped.jsonl': JsonlArtifact;
    'source-quarantine.jsonl': JsonlArtifact;
  };
  expected: FnsExactPlanExpected;
}

export interface FnsExactPlanValidationInput {
  manifest: FnsExactPlanManifest;
  summary: unknown;
  artifactHashes: Record<string, string>;
  artifactRows: Record<string, number>;
}

export interface ProcessFnsExactPlanFilesOptions {
  planDir: string;
  manifestPath: string;
  batchSize?: number;
  onUpdateBatch?: (rows: Record<string, unknown>[]) => Promise<void>;
  onConflictBatch?: (rows: Record<string, unknown>[]) => Promise<void>;
  onSkippedBatch?: (rows: Record<string, unknown>[]) => Promise<void>;
  onSourceQuarantineBatch?: (
    rows: Record<string, unknown>[],
  ) => Promise<void>;
}

export interface ProcessedFnsExactPlanFiles {
  manifest: FnsExactPlanManifest;
  summary: unknown;
  planFingerprint: string;
  updateRows: number;
  conflictRows: number;
  skippedRows: number;
  sourceQuarantinedRows: number;
  artifactHashes: Record<string, string>;
}

function assertRecord(value: unknown, label: string): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} fields mismatch`
      + `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''}`
      + `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`,
    );
  }
}

function assertCanonicalEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function validateAuditId(value: unknown): string {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid audit id: ${text}`);
  }
  const id = BigInt(text);
  if (id < BigInt(1) || id > POSTGRES_BIGINT_MAX) {
    throw new Error(`Invalid audit id: ${text}`);
  }
  return text;
}

function inferTaxpayerType(inn: string): 'legal_entity' | 'individual_entrepreneur' {
  if (inn.length === 10) return 'legal_entity';
  if (inn.length === 12) return 'individual_entrepreneur';
  throw new Error(`Invalid INN length: ${inn}`);
}

function validateInn(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('INN must be a string');
  }
  try {
    validateFnsInn(value, inferTaxpayerType(value));
  } catch (error) {
    throw new Error(
      `Invalid INN: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return value;
}

function validateOgrn(value: unknown, inn: string, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} OGRN must be a string`);
  }
  try {
    validateFnsOgrn(value, inferTaxpayerType(inn));
  } catch (error) {
    throw new Error(
      `Invalid ${label} OGRN: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return value;
}

function validateExpectedOgrn(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error('Expected target OGRN must be text or null');
  }
  return value;
}

function validateMatchIdentity(value: JsonObject): void {
  const inn = validateInn(value.inn);
  const expectedOgrn = validateExpectedOgrn(value.expected_ogrn);
  const fnsOgrn = validateOgrn(value.fns_ogrn, inn, 'FNS');
  if (value.match_method === 'ogrn_inn') {
    if (expectedOgrn !== fnsOgrn) {
      throw new Error('Direct OGRN/INN match identity is inconsistent');
    }
    return;
  }
  if (value.match_method === 'unique_inn_fallback') {
    if (expectedOgrn !== null && expectedOgrn.trim() !== '') {
      throw new Error('INN fallback requires an absent target OGRN');
    }
    return;
  }
  throw new Error('FNS exact match_method is invalid');
}

function validateSource(value: unknown, label: string): string {
  if (value !== FNS_SME_EXACT_OKVED_SOURCE) {
    throw new Error(`${label} source must be ${FNS_SME_EXACT_OKVED_SOURCE}`);
  }
  return value;
}

function validateExactOkved(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} OKVED must be a string`);
  }
  try {
    validateFnsOkvedCode(value);
  } catch (error) {
    throw new Error(
      `Invalid OKVED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return value;
}

export function validateFnsExactUpdateRow(value: unknown): JsonObject {
  assertRecord(value, 'FNS exact update row');
  assertExactKeys(value, [
    'id',
    'inn',
    'expected_ogrn',
    'fns_ogrn',
    'match_method',
    'okved_code_exact',
    'okved_exact_source',
  ], 'FNS exact update row');
  validateAuditId(value.id);
  validateMatchIdentity(value);
  validateExactOkved(value.okved_code_exact, 'Incoming');
  validateSource(value.okved_exact_source, 'Incoming');
  return value;
}

export function validateFnsExactConflictRow(value: unknown): JsonObject {
  assertRecord(value, 'FNS exact conflict row');
  assertExactKeys(value, [
    'id',
    'inn',
    'expected_ogrn',
    'fns_ogrn',
    'match_method',
    'kind',
    'existing_okved_code_exact',
    'existing_okved_exact_source',
    'incoming_okved_code_exact',
    'incoming_okved_exact_source',
  ], 'FNS exact conflict row');
  validateAuditId(value.id);
  validateMatchIdentity(value);
  if (value.kind !== 'existing_exact_preserved') {
    throw new Error('FNS exact conflict kind is invalid');
  }
  if (
    value.existing_okved_code_exact !== null
    && typeof value.existing_okved_code_exact !== 'string'
  ) {
    throw new Error('Existing OKVED must be text or null');
  }
  if (
    value.existing_okved_exact_source !== null
    && typeof value.existing_okved_exact_source !== 'string'
  ) {
    throw new Error('Existing exact source must be text or null');
  }
  validateExactOkved(value.incoming_okved_code_exact, 'Incoming');
  validateSource(value.incoming_okved_exact_source, 'Incoming');
  return value;
}

export function validateFnsExactSkippedRow(value: unknown): JsonObject {
  assertRecord(value, 'FNS exact skipped row');
  assertExactKeys(
    value,
    ['id', 'inn', 'expected_ogrn', 'reason'],
    'FNS exact skipped row',
  );
  validateAuditId(value.id);
  if (typeof value.inn !== 'string' || value.inn.length === 0) {
    throw new Error('Skipped target INN must be a non-empty string');
  }
  const expectedOgrn = validateExpectedOgrn(value.expected_ogrn);
  const reasons = [
    'invalid_target_inn',
    'invalid_target_ogrn',
    'ogrn_not_found',
    'ogrn_inn_mismatch',
    'inn_not_found',
    'ambiguous_inn_multiple_ogrn',
    'legacy_okved_2001',
  ];
  if (!reasons.includes(String(value.reason))) {
    throw new Error('FNS exact skipped reason is invalid');
  }
  if (value.reason === 'invalid_target_inn') {
    return value;
  }
  const inn = validateInn(value.inn);
  if (
    value.reason === 'inn_not_found'
    || value.reason === 'ambiguous_inn_multiple_ogrn'
  ) {
    if (expectedOgrn !== null && expectedOgrn.trim() !== '') {
      throw new Error('INN fallback audit requires an absent target OGRN');
    }
    return value;
  }
  if (value.reason === 'invalid_target_ogrn') {
    if (expectedOgrn === null || expectedOgrn.trim() === '') {
      throw new Error('Invalid target OGRN audit requires a present value');
    }
    try {
      validateOgrn(expectedOgrn, inn, 'target');
    } catch {
      return value;
    }
    throw new Error('Invalid target OGRN audit contains a valid OGRN');
  }
  if (expectedOgrn === null || expectedOgrn.trim() === '') {
    if (value.reason === 'legacy_okved_2001') return value;
    throw new Error('OGRN identity audit requires a present target OGRN');
  }
  validateOgrn(expectedOgrn, inn, 'target');
  return value;
}

export function validateFnsExactSourceQuarantineRow(
  value: unknown,
): JsonObject {
  assertRecord(value, 'FNS exact source-quarantine row');
  assertExactKeys(value, [
    'inn',
    'ogrn',
    'taxpayer_type',
    'okved_code_exact',
    'okved_version',
    'document_id',
    'registry_date',
    'source_entry_name',
    'source_file_id',
    'reason',
    'validation_error',
  ], 'FNS exact source-quarantine row');

  if (
    value.taxpayer_type !== 'legal_entity'
    && value.taxpayer_type !== 'individual_entrepreneur'
  ) {
    throw new Error('Source-quarantine taxpayer_type is invalid');
  }
  const taxpayerType = value.taxpayer_type as FnsSmeTaxpayerType;
  if (typeof value.inn !== 'string') {
    throw new Error('Source-quarantine INN must be a string');
  }
  validateFnsInn(value.inn, taxpayerType);
  if (typeof value.ogrn !== 'string') {
    throw new Error('Source-quarantine OGRN must be a string');
  }
  validateFnsOgrnStructure(value.ogrn, taxpayerType);
  let expectedValidationError: string | null = null;
  try {
    validateFnsOgrn(value.ogrn, taxpayerType);
  } catch (error) {
    expectedValidationError = error instanceof Error
      ? error.message
      : String(error);
  }
  if (expectedValidationError === null) {
    throw new Error('Source-quarantine row contains a valid OGRN');
  }
  if (value.reason !== 'invalid_source_ogrn') {
    throw new Error('Source-quarantine reason is invalid');
  }
  if (value.validation_error !== expectedValidationError) {
    throw new Error('Source-quarantine checksum error does not match OGRN');
  }
  validateExactOkved(value.okved_code_exact, 'Source-quarantine');
  if (value.okved_version !== '2001' && value.okved_version !== '2014') {
    throw new Error('Source-quarantine OKVED version is invalid');
  }
  if (typeof value.registry_date !== 'string') {
    throw new Error('Source-quarantine registry date must be a string');
  }
  validateFnsRegistryDate(value.registry_date);
  for (const [field, fieldValue] of [
    ['document_id', value.document_id],
    ['source_entry_name', value.source_entry_name],
    ['source_file_id', value.source_file_id],
  ] as const) {
    if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
      throw new Error(`Source-quarantine ${field} must be non-empty text`);
    }
  }
  const expectedFileId = validateFnsSmeZipEntryName(
    value.source_entry_name as string,
  );
  if (value.source_file_id !== expectedFileId) {
    throw new Error('Source-quarantine file provenance is inconsistent');
  }
  return value;
}

export function buildFnsExactPlanFingerprint(
  manifest: FnsExactPlanManifest,
): string {
  return sha256Hex(canonicalJson(manifest));
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function assertPinnedMetadata(manifest: FnsExactPlanManifest): void {
  assertCanonicalEqual(manifest.source.archive, {
    ...FNS_EXACT_OFFICIAL_ARCHIVE,
    sha256: manifest.source.archive.sha256,
  }, 'official FNS archive metadata');
  assertSha256Hex(
    manifest.source.archive.sha256,
    'official FNS archive SHA-256',
  );
  assertCanonicalEqual(manifest.source.xsd, {
    ...FNS_EXACT_OFFICIAL_XSD,
  }, 'official FNS XSD metadata');
  assertCanonicalEqual(
    manifest.target,
    FNS_EXACT_CURRENT_TARGET,
    'production target',
  );
  if (manifest.source.snapshot) {
    const snapshot = manifest.source.snapshot;
    if (
      snapshot.version !== 2
      ||
      typeof snapshot.file_name !== 'string'
      || !snapshot.file_name.trim()
      || !Number.isSafeInteger(snapshot.bytes)
      || snapshot.bytes < 1
      || !Number.isSafeInteger(snapshot.rows)
      || snapshot.rows < 1
      || Number.isNaN(Date.parse(snapshot.exported_at))
    ) {
      throw new Error('FNS exact snapshot metadata is invalid');
    }
    assertSha256Hex(snapshot.sha256, 'FNS exact snapshot SHA-256');
  }
}

export function validateFnsExactPlanManifest(
  input: FnsExactPlanValidationInput,
): { planFingerprint: string } {
  const { manifest } = input;
  if (manifest.version !== 2) {
    throw new Error(`Unsupported FNS exact plan version: ${manifest.version}`);
  }
  if (typeof manifest.plan !== 'string' || !manifest.plan.trim()) {
    throw new Error('FNS exact plan name is empty');
  }
  assertPinnedMetadata(manifest);

  assertRecord(manifest.artifacts, 'FNS exact artifacts');
  assertExactKeys(
    manifest.artifacts as unknown as JsonObject,
    ARTIFACT_NAMES,
    'FNS exact artifacts',
  );
  for (const artifactName of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts[artifactName];
    assertSha256Hex(artifact.sha256, `${artifactName} manifest SHA-256`);
    const actualHash = input.artifactHashes[artifactName];
    assertSha256Hex(actualHash, `${artifactName} actual SHA-256`);
    if (actualHash.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error(`${artifactName} SHA-256 mismatch`);
    }
    if ('rows' in artifact) {
      const actualRows = input.artifactRows[artifactName];
      if (actualRows !== artifact.rows) {
        throw new Error(
          `${artifactName} row count mismatch: `
          + `expected ${artifact.rows}, got ${String(actualRows)}`,
        );
      }
    }
  }

  const expected = manifest.expected;
  for (const [key, value] of Object.entries(expected)) {
    assertNonNegativeInteger(value, `expected.${key}`);
  }
  if (expected.inserts !== 0) {
    throw new Error('FNS exact plan must contain zero inserts');
  }
  if (
    expected.matched_by_ogrn_rows
      + expected.matched_by_unique_inn_rows
    !== expected.matched_directory_rows
  ) {
    throw new Error('FNS exact match-method counts are inconsistent');
  }
  if (
    expected.updates + expected.noops + expected.conflicts
    !== expected.matched_directory_rows
  ) {
    throw new Error('FNS exact matched-state counts are inconsistent');
  }
  if (
    input.artifactRows['updates.jsonl'] !== expected.updates
    || input.artifactRows['conflicts.jsonl'] !== expected.conflicts
    || input.artifactRows['skipped.jsonl'] !== expected.skipped
    || input.artifactRows['source-quarantine.jsonl']
      !== expected.source_quarantined
  ) {
    throw new Error('FNS exact artifact counts do not match expected counts');
  }

  assertRecord(input.summary, 'summary.json');
  if (
    input.summary.dryRunOnly !== true
    || input.summary.mode !== 'existing-only-exact-okved-ogrn-first'
  ) {
    throw new Error('summary.json mode/dryRunOnly is invalid');
  }
  assertCanonicalEqual(
    input.summary.source,
    manifest.source,
    'summary source',
  );
  assertCanonicalEqual(
    input.summary.target,
    manifest.target,
    'summary target',
  );
  assertCanonicalEqual(
    input.summary.combined,
    manifest.expected,
    'summary combined counts',
  );
  assertRecord(input.summary.idempotencyCheck, 'summary idempotency check');
  if (
    input.summary.idempotencyCheck.passed !== true
    || input.summary.idempotencyCheck.repeatedUpdates !== 0
  ) {
    throw new Error('summary idempotency check did not pass');
  }

  return {
    planFingerprint: buildFnsExactPlanFingerprint(manifest),
  };
}

async function processJsonlArtifact(input: {
  filePath: string;
  label: string;
  batchSize: number;
  validate(value: unknown): JsonObject;
  key(value: JsonObject): string;
  seenTargetIds?: Set<string>;
  onBatch?: (rows: JsonObject[]) => Promise<void>;
}): Promise<{ rows: number; sha256: string }> {
  let batch: JsonObject[] = [];
  const seenKeys = new Set<string>();
  const result = await readJsonLines(
    input.filePath,
    input.label,
    async (raw) => {
      const row = input.validate(raw);
      const serializedKey = input.key(row);
      if (seenKeys.has(serializedKey)) {
        throw new Error(
          `${input.label} contains a duplicate target id`,
        );
      }
      seenKeys.add(serializedKey);
      if (input.seenTargetIds?.has(serializedKey)) {
        throw new Error(
          `Target id ${serializedKey} appears in multiple FNS artifacts`,
        );
      }
      input.seenTargetIds?.add(serializedKey);
      batch.push(row);
      if (batch.length >= input.batchSize) {
        await input.onBatch?.(batch);
        batch = [];
      }
    },
  );
  if (batch.length > 0) {
    await input.onBatch?.(batch);
  }
  return result;
}

async function assertNoInsertArtifact(planDir: string): Promise<void> {
  try {
    await access(path.join(planDir, 'inserts.jsonl'));
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
  throw new Error('Unexpected inserts.jsonl artifact is forbidden');
}

export async function processFnsExactPlanFiles(
  options: ProcessFnsExactPlanFilesOptions,
): Promise<ProcessedFnsExactPlanFiles> {
  const batchSize = options.batchSize ?? 5_000;
  if (
    !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > 20_000
  ) {
    throw new Error('FNS exact staging batchSize must be between 1 and 20000');
  }
  const planDir = path.resolve(options.planDir);
  await assertNoInsertArtifact(planDir);

  const manifestBuffer = await readFile(path.resolve(options.manifestPath));
  const manifest = parseJsonValue<unknown>(
    manifestBuffer,
    'FNS exact manifest',
  );
  assertRecord(manifest, 'FNS exact manifest');
  const typedManifest = manifest as unknown as FnsExactPlanManifest;

  const summaryPath = path.join(planDir, 'summary.json');
  const summaryBuffer = await readFile(summaryPath);
  const summary = parseJsonValue<unknown>(summaryBuffer, 'summary.json');
  const artifactHashes: Record<string, string> = {
    'summary.json': createHash('sha256').update(summaryBuffer).digest('hex'),
  };
  const seenTargetIds = new Set<string>();

  const updates = await processJsonlArtifact({
    filePath: path.join(planDir, 'updates.jsonl'),
    label: 'updates.jsonl',
    batchSize,
    validate: validateFnsExactUpdateRow,
    key: (row) => String(row.id),
    seenTargetIds,
    onBatch: options.onUpdateBatch,
  });
  artifactHashes['updates.jsonl'] = updates.sha256;

  const conflicts = await processJsonlArtifact({
    filePath: path.join(planDir, 'conflicts.jsonl'),
    label: 'conflicts.jsonl',
    batchSize,
    validate: validateFnsExactConflictRow,
    key: (row) => String(row.id),
    seenTargetIds,
    onBatch: options.onConflictBatch,
  });
  artifactHashes['conflicts.jsonl'] = conflicts.sha256;

  const skipped = await processJsonlArtifact({
    filePath: path.join(planDir, 'skipped.jsonl'),
    label: 'skipped.jsonl',
    batchSize,
    validate: validateFnsExactSkippedRow,
    key: (row) => String(row.id),
    seenTargetIds,
    onBatch: options.onSkippedBatch,
  });
  artifactHashes['skipped.jsonl'] = skipped.sha256;

  const sourceQuarantine = await processJsonlArtifact({
    filePath: path.join(planDir, 'source-quarantine.jsonl'),
    label: 'source-quarantine.jsonl',
    batchSize,
    validate: validateFnsExactSourceQuarantineRow,
    key: (row) => [
      row.ogrn,
      row.document_id,
      row.source_entry_name,
    ].join(':'),
    onBatch: options.onSourceQuarantineBatch,
  });
  artifactHashes['source-quarantine.jsonl'] = sourceQuarantine.sha256;

  const validation = validateFnsExactPlanManifest({
    manifest: typedManifest,
    summary,
    artifactHashes,
    artifactRows: {
      'updates.jsonl': updates.rows,
      'conflicts.jsonl': conflicts.rows,
      'skipped.jsonl': skipped.rows,
      'source-quarantine.jsonl': sourceQuarantine.rows,
    },
  });

  return {
    manifest: typedManifest,
    summary,
    planFingerprint: validation.planFingerprint,
    updateRows: updates.rows,
    conflictRows: conflicts.rows,
    skippedRows: skipped.rows,
    sourceQuarantinedRows: sourceQuarantine.rows,
    artifactHashes,
  };
}
