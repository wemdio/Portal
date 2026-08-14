import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  assertSha256Hex,
  canonicalJson,
  isJsonObject,
  sha256Hex,
  type JsonObject,
} from '@/lib/companiesDirectory/guardedImportCore';
import {
  validateFnsInn,
  validateFnsOgrn,
  validateFnsOkvedCode,
} from '@/lib/companiesDirectory/fnsSmeXml';
import {
  SBIS_EXACT_OKVED_SOURCE,
  type SbisExactOkvedConflict,
  type SbisExactOkvedNoop,
  type SbisExactOkvedProvenance,
  type SbisExactOkvedSkipped,
  type SbisExactOkvedUpdate,
  type SbisExactSourceEvidence,
  type SbisExactSourceQuarantineRow,
} from '@/lib/companiesDirectory/sbisExactOkvedPlan';
import {
  parseJsonValue,
  readJsonLines,
} from '@/lib/companiesDirectory/planFileIO';

const PLAN = 'sbis-exact-okved-v1';
const CURRENT_TARGET = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'companies_directory',
} as const;
const PINNED_SOURCE = {
  id: SBIS_EXACT_OKVED_SOURCE,
  analysis: {
    file_name: 'registry-exact-source-analysis.json',
    sha256:
      '351ac4660cc0242e453ed8f0ce1c7ce415fb165441c8b2a67c73c11d922028d7',
    candidates: 134_199,
  },
  locations: {
    file_name: 'source-locations.jsonl',
    sha256:
      '55526b74173593d752f57609d98ede0a14d359b038cbd8005bf4c787bbc0f526',
    rows: 160_028,
  },
  registry_manifest: {
    file_name: 'polza-registry-v2.manifest.json',
    sha256:
      'b3688f8c511349f86d1075fad46e25def272e835e04388239a56c36468d64a8e',
  },
} as const;
const PINNED_REFERENCE = {
  count: 2_680,
  md5: '83d8fe43ba6c52b8e11024258a467783',
} as const;
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
const JSONL_ARTIFACT_NAMES = ARTIFACT_NAMES.filter(
  (name): name is Exclude<typeof ARTIFACT_NAMES[number], 'summary.json'> =>
    name !== 'summary.json',
);
const POSTGRES_BIGINT_MAX = BigInt('9223372036854775807');

type ArtifactName = typeof ARTIFACT_NAMES[number];
type JsonlArtifactName = typeof JSONL_ARTIFACT_NAMES[number];

interface HashedArtifact {
  sha256: string;
}

interface JsonlArtifact extends HashedArtifact {
  rows: number;
}

export interface SbisExactPlanExpected {
  source_rows: number;
  unique_source_identities: number;
  matched_directory_rows: number;
  updates: number;
  noops: number;
  conflicts: number;
  skipped: number;
  source_quarantined: number;
  provenance: number;
  rollback: number;
  inserts: 0;
}

export interface SbisExactPlanManifest {
  version: 1;
  plan: typeof PLAN;
  source: typeof PINNED_SOURCE;
  reference: typeof PINNED_REFERENCE;
  snapshot: {
    file_name: string;
    sha256: string;
    candidate_rows: number;
    target_rows: number;
    exported_at: string;
    target: typeof CURRENT_TARGET;
  };
  target: typeof CURRENT_TARGET;
  artifacts: Record<ArtifactName, HashedArtifact | JsonlArtifact>;
  expected: SbisExactPlanExpected;
}

interface ValidationInput {
  manifest: SbisExactPlanManifest;
  summary: unknown;
  artifactHashes: Record<string, string>;
  artifactRows: Record<string, number>;
}

interface BatchCallbacks {
  onUpdateBatch?(rows: Record<string, unknown>[]): Promise<void>;
  onNoopBatch?(rows: Record<string, unknown>[]): Promise<void>;
  onConflictBatch?(rows: Record<string, unknown>[]): Promise<void>;
  onSkippedBatch?(rows: Record<string, unknown>[]): Promise<void>;
  onSourceQuarantineBatch?(rows: Record<string, unknown>[]): Promise<void>;
  onProvenanceBatch?(rows: Record<string, unknown>[]): Promise<void>;
  onRollbackBatch?(rows: Record<string, unknown>[]): Promise<void>;
}

export interface ProcessSbisExactPlanFilesOptions extends BatchCallbacks {
  planDir: string;
  manifestPath: string;
  batchSize?: number;
}

export interface ProcessedSbisExactPlanFiles {
  manifest: SbisExactPlanManifest;
  summary: unknown;
  planFingerprint: string;
  updateRows: number;
  noopRows: number;
  conflictRows: number;
  skippedRows: number;
  sourceQuarantinedRows: number;
  provenanceRows: number;
  rollbackRows: number;
  artifactHashes: Record<string, string>;
}

interface ApplyUpdateRow extends Record<string, unknown> {
  id: string;
  inn: string;
  expected_ogrn: string;
  fns_ogrn: string;
  match_method: 'ogrn_inn';
  okved_code_exact: string;
  okved_exact_source: typeof SBIS_EXACT_OKVED_SOURCE;
}

interface RollbackRow {
  action: 'restore_exact';
  id: string;
  inn: string;
  expected_ogrn: string;
  okved_code_exact: string | null;
  okved_exact_source: string | null;
}

function assertRecord(value: unknown, label: string): asserts value is JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const missing = expected.filter((key) => !(key in value));
  const unexpected = keys.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} fields mismatch`
      + `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`
      + `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''}`,
    );
  }
}

function exactObject(value: unknown, expected: readonly string[], label: string): JsonObject {
  assertRecord(value, label);
  assertExactKeys(value, expected, label);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be non-empty text`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be text or null`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

function validateId(value: unknown, label = 'id'): string {
  const id = stringValue(value, label);
  if (!/^\d+$/.test(id)) throw new Error(`${label} must be numeric`);
  const numeric = BigInt(id);
  if (numeric < BigInt(1) || numeric > POSTGRES_BIGINT_MAX) {
    throw new Error(`${label} is outside bigint range`);
  }
  return id;
}

function taxpayerType(inn: string): 'legal_entity' | 'individual_entrepreneur' {
  if (inn.length === 10) return 'legal_entity';
  if (inn.length === 12) return 'individual_entrepreneur';
  throw new Error('INN length is invalid');
}

function validateInn(value: unknown): string {
  const inn = stringValue(value, 'INN');
  validateFnsInn(inn, taxpayerType(inn));
  return inn;
}

function validateOgrn(value: unknown, inn: string, label: string): string {
  const ogrn = stringValue(value, label);
  validateFnsOgrn(ogrn, taxpayerType(inn));
  return ogrn;
}

function validateOkved(value: unknown, label: string): string {
  const okved = stringValue(value, label);
  validateFnsOkvedCode(okved);
  return okved;
}

function validateSource(value: unknown, label: string): typeof SBIS_EXACT_OKVED_SOURCE {
  if (value !== SBIS_EXACT_OKVED_SOURCE) {
    throw new Error(`${label} source must be ${SBIS_EXACT_OKVED_SOURCE}`);
  }
  return SBIS_EXACT_OKVED_SOURCE;
}

function validateEvidence(value: unknown, label: string): SbisExactSourceEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} sources must be a non-empty array`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const row = exactObject(
      entry,
      ['source_file', 'sha256', 'rowNumbers'],
      `${label} source ${index + 1}`,
    );
    const sourceFile = stringValue(row.source_file, `${label} source_file`);
    assertSha256Hex(row.sha256, `${label} source SHA`);
    if (!Array.isArray(row.rowNumbers) || row.rowNumbers.length === 0) {
      throw new Error(`${label} rowNumbers must be a non-empty array`);
    }
    const rowNumbers = row.rowNumbers.map((number) =>
      positiveInteger(number, `${label} row number`)
    );
    if (new Set(rowNumbers).size !== rowNumbers.length) {
      throw new Error(`${label} contains duplicate row numbers`);
    }
    const key = `${sourceFile}\u0000${String(row.sha256).toLowerCase()}`;
    if (seen.has(key)) throw new Error(`${label} contains duplicate source evidence`);
    seen.add(key);
    return {
      source_file: sourceFile,
      sha256: String(row.sha256).toLowerCase(),
      rowNumbers,
    };
  });
}

function validateIdentityFields(
  value: JsonObject,
): {
  id: string;
  inn: string;
  expectedOgrn: string;
  registryOgrn: string;
} {
  const id = validateId(value.id);
  const inn = validateInn(value.inn);
  const expectedOgrn = validateOgrn(value.expected_ogrn, inn, 'expected OGRN');
  const registryOgrn = validateOgrn(value.registry_ogrn, inn, 'registry OGRN');
  if (expectedOgrn !== registryOgrn || value.match_method !== 'ogrn_inn') {
    throw new Error('Strict INN+OGRN match identity is inconsistent');
  }
  return { id, inn, expectedOgrn, registryOgrn };
}

export function validateSbisExactUpdateRow(value: unknown): SbisExactOkvedUpdate {
  const row = exactObject(value, [
    'id', 'inn', 'expected_ogrn', 'registry_ogrn', 'match_method',
    'okved_code_exact', 'okved_exact_source',
  ], 'SBIS exact update');
  const identity = validateIdentityFields(row);
  return {
    id: identity.id,
    inn: identity.inn,
    expected_ogrn: identity.expectedOgrn,
    registry_ogrn: identity.registryOgrn,
    match_method: 'ogrn_inn',
    okved_code_exact: validateOkved(row.okved_code_exact, 'exact OKVED'),
    okved_exact_source: validateSource(row.okved_exact_source, 'Update'),
  };
}

function validateNoopRow(value: unknown): SbisExactOkvedNoop {
  const row = exactObject(value, [
    'id', 'inn', 'expected_ogrn', 'registry_ogrn', 'match_method',
    'reason',
  ], 'SBIS exact noop');
  const identity = validateIdentityFields(row);
  if (row.reason !== 'already_exact') throw new Error('Invalid noop reason');
  return {
    id: identity.id,
    inn: identity.inn,
    expected_ogrn: identity.expectedOgrn,
    registry_ogrn: identity.registryOgrn,
    match_method: 'ogrn_inn',
    reason: 'already_exact',
  };
}

function validateConflictRow(value: unknown): SbisExactOkvedConflict {
  const row = exactObject(value, [
    'id', 'inn', 'expected_ogrn', 'registry_ogrn', 'match_method', 'kind',
    'existing_okved_code_exact', 'existing_okved_exact_source',
    'incoming_okved_code_exact', 'incoming_okved_exact_source',
  ], 'SBIS exact conflict');
  const identity = validateIdentityFields(row);
  if (!['existing_exact_preserved', 'partial_existing_exact_state'].includes(String(row.kind))) {
    throw new Error('Invalid conflict kind');
  }
  return {
    id: identity.id,
    inn: identity.inn,
    expected_ogrn: identity.expectedOgrn,
    registry_ogrn: identity.registryOgrn,
    match_method: 'ogrn_inn',
    kind: row.kind as SbisExactOkvedConflict['kind'],
    existing_okved_code_exact: nullableString(
      row.existing_okved_code_exact,
      'existing exact OKVED',
    ),
    existing_okved_exact_source: nullableString(
      row.existing_okved_exact_source,
      'existing exact source',
    ),
    incoming_okved_code_exact: validateOkved(
      row.incoming_okved_code_exact,
      'incoming exact OKVED',
    ),
    incoming_okved_exact_source: validateSource(
      row.incoming_okved_exact_source,
      'Conflict incoming',
    ),
  };
}

function validateSkippedRow(value: unknown): SbisExactOkvedSkipped {
  const row = exactObject(
    value,
    Object.prototype.hasOwnProperty.call(value, 'target_ids')
      ? ['inn', 'registry_ogrn', 'reason', 'target_ids']
      : ['inn', 'registry_ogrn', 'reason'],
    'SBIS exact skipped row',
  );
  const inn = validateInn(row.inn);
  const registryOgrn = validateOgrn(row.registry_ogrn, inn, 'registry OGRN');
  const reasons: SbisExactOkvedSkipped['reason'][] = [
    'target_identity_not_found',
    'ambiguous_target_inn',
    'ambiguous_target_identity',
  ];
  if (!reasons.includes(row.reason as SbisExactOkvedSkipped['reason'])) {
    throw new Error('Invalid skipped reason');
  }
  const targetIds = row.target_ids === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(row.target_ids) || row.target_ids.length === 0) {
        throw new Error('Skipped target_ids must be non-empty');
      }
      const ids = row.target_ids.map((id) => validateId(id, 'target id'));
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate skipped target id');
      return ids;
    })();
  if ((row.reason === 'target_identity_not_found') !== (targetIds === undefined)) {
    throw new Error('Skipped reason and target_ids are inconsistent');
  }
  return {
    inn,
    registry_ogrn: registryOgrn,
    reason: row.reason as SbisExactOkvedSkipped['reason'],
    ...(targetIds ? { target_ids: targetIds } : {}),
  };
}

function validateSourceQuarantineRow(value: unknown): SbisExactSourceQuarantineRow {
  assertRecord(value, 'SBIS source quarantine row');
  const allowed = [
    'inn', 'ogrn', 'okved_code_exact', 'okved_codes', 'reason',
    'validation_error', 'sources',
  ];
  const required = ['inn', 'ogrn', 'reason', 'sources'];
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error('SBIS source quarantine row fields mismatch');
  }
  const reasons: SbisExactSourceQuarantineRow['reason'][] = [
    'invalid_source_inn', 'invalid_source_ogrn', 'invalid_source_provenance',
    'invalid_okved_code', 'okved_not_in_reference', 'conflicting_source_ogrn',
    'conflicting_source_okved', 'identity_has_quarantined_source_row',
  ];
  if (!reasons.includes(value.reason as SbisExactSourceQuarantineRow['reason'])) {
    throw new Error('Invalid source quarantine reason');
  }
  const okvedCodes = value.okved_codes === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(value.okved_codes) || value.okved_codes.length === 0) {
        throw new Error('Quarantine OKVED codes must be non-empty');
      }
      return value.okved_codes.map((code) => validateOkved(code, 'quarantine OKVED'));
    })();
  return {
    inn: stringValue(value.inn, 'quarantine INN'),
    ogrn: stringValue(value.ogrn, 'quarantine OGRN'),
    ...(value.okved_code_exact === undefined
      ? {}
      : { okved_code_exact: stringValue(value.okved_code_exact, 'quarantine OKVED') }),
    ...(okvedCodes ? { okved_codes: okvedCodes } : {}),
    reason: value.reason as SbisExactSourceQuarantineRow['reason'],
    ...(value.validation_error === undefined
      ? {}
      : { validation_error: stringValue(value.validation_error, 'validation error') }),
    sources: validateEvidence(value.sources, 'quarantine'),
  };
}

function validateProvenanceRow(value: unknown): SbisExactOkvedProvenance {
  const row = exactObject(value, [
    'action', 'id', 'inn', 'ogrn', 'okved_code_exact', 'sources',
  ], 'SBIS exact provenance');
  if (row.action !== 'update') throw new Error('Invalid provenance action');
  const inn = validateInn(row.inn);
  return {
    action: 'update',
    id: validateId(row.id),
    inn,
    ogrn: validateOgrn(row.ogrn, inn, 'provenance OGRN'),
    okved_code_exact: validateOkved(row.okved_code_exact, 'provenance OKVED'),
    sources: validateEvidence(row.sources, 'provenance'),
  };
}

function validateRollbackRow(value: unknown): RollbackRow {
  const row = exactObject(value, [
    'action', 'id', 'inn', 'expected_ogrn',
    'okved_code_exact', 'okved_exact_source',
  ], 'SBIS exact rollback');
  if (row.action !== 'restore_exact') throw new Error('Invalid rollback action');
  const inn = validateInn(row.inn);
  return {
    action: 'restore_exact',
    id: validateId(row.id),
    inn,
    expected_ogrn: validateOgrn(row.expected_ogrn, inn, 'rollback OGRN'),
    okved_code_exact: nullableString(row.okved_code_exact, 'rollback exact OKVED'),
    okved_exact_source: nullableString(row.okved_exact_source, 'rollback source'),
  };
}

function validateExpected(value: unknown): SbisExactPlanExpected {
  const row = exactObject(value, [
    'source_rows', 'unique_source_identities', 'matched_directory_rows',
    'updates', 'noops', 'conflicts', 'skipped', 'source_quarantined',
    'provenance', 'rollback', 'inserts',
  ], 'SBIS exact expected metrics');
  if (row.inserts !== 0) throw new Error('SBIS exact plan inserts must be zero');
  return {
    source_rows: nonNegativeInteger(row.source_rows, 'source_rows'),
    unique_source_identities: nonNegativeInteger(
      row.unique_source_identities,
      'unique_source_identities',
    ),
    matched_directory_rows: nonNegativeInteger(
      row.matched_directory_rows,
      'matched_directory_rows',
    ),
    updates: nonNegativeInteger(row.updates, 'updates'),
    noops: nonNegativeInteger(row.noops, 'noops'),
    conflicts: nonNegativeInteger(row.conflicts, 'conflicts'),
    skipped: nonNegativeInteger(row.skipped, 'skipped'),
    source_quarantined: nonNegativeInteger(
      row.source_quarantined,
      'source_quarantined',
    ),
    provenance: nonNegativeInteger(row.provenance, 'provenance'),
    rollback: nonNegativeInteger(row.rollback, 'rollback'),
    inserts: 0,
  };
}

function validateArtifactSet(value: unknown): SbisExactPlanManifest['artifacts'] {
  const artifacts = exactObject(value, ARTIFACT_NAMES, 'SBIS exact artifacts');
  return Object.fromEntries(ARTIFACT_NAMES.map((name) => {
    const expectedKeys = name === 'summary.json' ? ['sha256'] : ['sha256', 'rows'];
    const artifact = exactObject(artifacts[name], expectedKeys, name);
    assertSha256Hex(artifact.sha256, `${name} SHA`);
    return [name, {
      sha256: String(artifact.sha256).toLowerCase(),
      ...(name === 'summary.json'
        ? {}
        : { rows: nonNegativeInteger(artifact.rows, `${name} rows`) }),
    }];
  })) as SbisExactPlanManifest['artifacts'];
}

function validatePinnedSource(value: unknown): typeof PINNED_SOURCE {
  const source = exactObject(
    value,
    ['id', 'analysis', 'locations', 'registry_manifest'],
    'SBIS exact source metadata',
  );
  const analysis = exactObject(
    source.analysis,
    ['file_name', 'sha256', 'candidates'],
    'SBIS exact source analysis',
  );
  const locations = exactObject(
    source.locations,
    ['file_name', 'sha256', 'rows'],
    'SBIS exact source locations',
  );
  const registryManifest = exactObject(
    source.registry_manifest,
    ['file_name', 'sha256'],
    'SBIS registry manifest metadata',
  );
  validateSource(source.id, 'Manifest');
  assertSha256Hex(analysis.sha256, 'Source analysis SHA');
  assertSha256Hex(locations.sha256, 'Source locations SHA');
  assertSha256Hex(registryManifest.sha256, 'Registry manifest SHA');
  nonNegativeInteger(analysis.candidates, 'Source analysis candidates');
  nonNegativeInteger(locations.rows, 'Source locations rows');
  const normalized = {
    id: SBIS_EXACT_OKVED_SOURCE,
    analysis: {
      file_name: stringValue(analysis.file_name, 'Source analysis file name'),
      sha256: String(analysis.sha256).toLowerCase(),
      candidates: Number(analysis.candidates),
    },
    locations: {
      file_name: stringValue(locations.file_name, 'Source locations file name'),
      sha256: String(locations.sha256).toLowerCase(),
      rows: Number(locations.rows),
    },
    registry_manifest: {
      file_name: stringValue(
        registryManifest.file_name,
        'Registry manifest file name',
      ),
      sha256: String(registryManifest.sha256).toLowerCase(),
    },
  };
  if (canonicalJson(normalized) !== canonicalJson(PINNED_SOURCE)) {
    throw new Error('SBIS exact source metadata does not match pinned inputs');
  }
  return PINNED_SOURCE;
}

function validatePinnedReference(value: unknown): typeof PINNED_REFERENCE {
  const reference = exactObject(
    value,
    ['count', 'md5'],
    'SBIS exact OKVED reference',
  );
  const count = nonNegativeInteger(reference.count, 'OKVED reference count');
  const md5 = stringValue(reference.md5, 'OKVED reference MD5').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) {
    throw new Error('OKVED reference MD5 must be a 32-character hex digest');
  }
  if (count !== PINNED_REFERENCE.count || md5 !== PINNED_REFERENCE.md5) {
    throw new Error('OKVED reference does not match the pinned digest');
  }
  return PINNED_REFERENCE;
}

function validateSnapshot(
  value: unknown,
): SbisExactPlanManifest['snapshot'] {
  const snapshot = exactObject(
    value,
    [
      'file_name', 'sha256', 'candidate_rows', 'target_rows',
      'exported_at', 'target',
    ],
    'SBIS exact target snapshot',
  );
  assertSha256Hex(snapshot.sha256, 'Target snapshot SHA');
  const candidateRows = nonNegativeInteger(
    snapshot.candidate_rows,
    'Target snapshot candidate rows',
  );
  const targetRows = nonNegativeInteger(
    snapshot.target_rows,
    'Target snapshot target rows',
  );
  if (candidateRows !== PINNED_SOURCE.analysis.candidates) {
    throw new Error('Target snapshot candidate rows do not match source candidates');
  }
  const exportedAt = stringValue(snapshot.exported_at, 'Snapshot exported_at');
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw new Error('Snapshot exported_at is not a valid date');
  }
  const target = exactObject(
    snapshot.target,
    ['host', 'port', 'database', 'table'],
    'SBIS exact snapshot target',
  );
  if (canonicalJson(target) !== canonicalJson(CURRENT_TARGET)) {
    throw new Error('SBIS exact snapshot target is not current Portal production');
  }
  return {
    file_name: stringValue(snapshot.file_name, 'Snapshot file name'),
    sha256: String(snapshot.sha256).toLowerCase(),
    candidate_rows: candidateRows,
    target_rows: targetRows,
    exported_at: exportedAt,
    target: CURRENT_TARGET,
  };
}

function validateManifest(value: unknown): SbisExactPlanManifest {
  const row = exactObject(value, [
    'version', 'plan', 'source', 'reference', 'snapshot', 'target',
    'artifacts', 'expected',
  ], 'SBIS exact manifest');
  if (row.version !== 1 || row.plan !== PLAN) {
    throw new Error('SBIS exact manifest version/plan is invalid');
  }
  const source = validatePinnedSource(row.source);
  const reference = validatePinnedReference(row.reference);
  const snapshot = validateSnapshot(row.snapshot);
  const target = exactObject(
    row.target,
    ['host', 'port', 'database', 'table'],
    'SBIS exact target',
  );
  if (canonicalJson(target) !== canonicalJson(CURRENT_TARGET)) {
    throw new Error('SBIS exact target is not current Portal production');
  }
  return {
    version: 1,
    plan: PLAN,
    source,
    reference,
    snapshot,
    target: CURRENT_TARGET,
    artifacts: validateArtifactSet(row.artifacts),
    expected: validateExpected(row.expected),
  };
}

export function buildSbisExactPlanFingerprint(
  manifest: SbisExactPlanManifest,
): string {
  return sha256Hex(canonicalJson(manifest));
}

export function validateSbisExactPlanManifest(input: ValidationInput): {
  planFingerprint: string;
} {
  const manifest = validateManifest(input.manifest);
  const hashes = exactObject(
    input.artifactHashes,
    ARTIFACT_NAMES,
    'SBIS exact artifact hashes',
  );
  const rowCounts = exactObject(
    input.artifactRows,
    JSONL_ARTIFACT_NAMES,
    'SBIS exact artifact row counts',
  );
  for (const name of ARTIFACT_NAMES) {
    assertSha256Hex(hashes[name], `${name} actual SHA`);
    if (String(hashes[name]).toLowerCase() !== manifest.artifacts[name].sha256) {
      throw new Error(`${name} SHA mismatch`);
    }
    if (name !== 'summary.json') {
      const actualRows = nonNegativeInteger(rowCounts[name], `${name} actual rows`);
      const declared = manifest.artifacts[name] as JsonlArtifact;
      if (actualRows !== declared.rows) throw new Error(`${name} row count mismatch`);
    }
  }
  const expectedRows: Record<JsonlArtifactName, number> = {
    'updates.jsonl': manifest.expected.updates,
    'noops.jsonl': manifest.expected.noops,
    'conflicts.jsonl': manifest.expected.conflicts,
    'skipped.jsonl': manifest.expected.skipped,
    'source-quarantine.jsonl': manifest.expected.source_quarantined,
    'provenance.jsonl': manifest.expected.provenance,
    'rollback.jsonl': manifest.expected.rollback,
  };
  for (const name of JSONL_ARTIFACT_NAMES) {
    if ((manifest.artifacts[name] as JsonlArtifact).rows !== expectedRows[name]) {
      throw new Error(`${name} expected count mismatch`);
    }
  }
  if (
    manifest.expected.matched_directory_rows
    !== manifest.expected.updates
      + manifest.expected.noops
      + manifest.expected.conflicts
  ) {
    throw new Error('Matched directory row count is inconsistent');
  }
  const summary = exactObject(input.summary, [
    'dryRunOnly', 'mode', 'source', 'reference', 'snapshot', 'target',
    'combined', 'idempotencyCheck',
  ], 'SBIS exact summary');
  if (
    summary.dryRunOnly !== true
    || summary.mode !== 'existing-only-exact-okved-strict-inn-ogrn'
  ) {
    throw new Error('SBIS exact summary mode is invalid');
  }
  if (
    canonicalJson(summary.source) !== canonicalJson(manifest.source)
    || canonicalJson(summary.reference) !== canonicalJson(manifest.reference)
    || canonicalJson(summary.snapshot) !== canonicalJson(manifest.snapshot)
    || canonicalJson(summary.target) !== canonicalJson(CURRENT_TARGET)
    || canonicalJson(summary.combined) !== canonicalJson(manifest.expected)
  ) {
    throw new Error('SBIS exact summary pinned metadata or counts mismatch');
  }
  const idempotency = exactObject(
    summary.idempotencyCheck,
    ['repeatedUpdates', 'passed'],
    'SBIS exact idempotency check',
  );
  if (idempotency.repeatedUpdates !== 0 || idempotency.passed !== true) {
    throw new Error('SBIS exact plan is not idempotent');
  }
  return { planFingerprint: buildSbisExactPlanFingerprint(manifest) };
}

const validators: Record<JsonlArtifactName, (value: unknown) => Record<string, unknown>> = {
  'updates.jsonl': (value) => validateSbisExactUpdateRow(value) as unknown as Record<string, unknown>,
  'noops.jsonl': (value) => validateNoopRow(value) as unknown as Record<string, unknown>,
  'conflicts.jsonl': (value) => validateConflictRow(value) as unknown as Record<string, unknown>,
  'skipped.jsonl': (value) => validateSkippedRow(value) as unknown as Record<string, unknown>,
  'source-quarantine.jsonl': (value) => validateSourceQuarantineRow(value) as unknown as Record<string, unknown>,
  'provenance.jsonl': (value) => validateProvenanceRow(value) as unknown as Record<string, unknown>,
  'rollback.jsonl': (value) => validateRollbackRow(value) as unknown as Record<string, unknown>,
};

function applyUpdate(row: Record<string, unknown>): ApplyUpdateRow {
  const update = row as unknown as SbisExactOkvedUpdate;
  return {
    id: update.id,
    inn: update.inn,
    expected_ogrn: update.expected_ogrn,
    fns_ogrn: update.registry_ogrn,
    match_method: update.match_method,
    okved_code_exact: update.okved_code_exact,
    okved_exact_source: update.okved_exact_source,
  };
}

export async function processSbisExactPlanFiles(
  options: ProcessSbisExactPlanFilesOptions,
): Promise<ProcessedSbisExactPlanFiles> {
  const batchSize = options.batchSize ?? 1_000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive safe integer');
  }
  const planDir = path.resolve(options.planDir);
  const manifestPath = path.resolve(options.manifestPath);
  const names = await readdir(planDir);
  const unexpectedJsonArtifacts = names.filter((name) =>
    /\.(?:json|jsonl)$/i.test(name)
    && name !== path.basename(manifestPath)
    && !ARTIFACT_NAMES.includes(name as ArtifactName)
  );
  if (unexpectedJsonArtifacts.length > 0) {
    throw new Error(`Unexpected artifact: ${unexpectedJsonArtifacts.join(', ')}`);
  }
  for (const name of ARTIFACT_NAMES) {
    await access(path.join(planDir, name));
  }

  const manifest = validateManifest(parseJsonValue(
    await readFile(manifestPath),
    'SBIS exact manifest',
  ));
  const summaryPath = path.join(planDir, 'summary.json');
  const summaryBytes = await readFile(summaryPath);
  const summary = parseJsonValue(summaryBytes, 'SBIS exact summary');
  const artifactHashes: Record<string, string> = {
    'summary.json': sha256Hex(summaryBytes),
  };
  const artifactRows: Record<string, number> = {};
  const rowsByArtifact = new Map<JsonlArtifactName, Record<string, unknown>[]>();
  const targetIds = new Map<string, JsonlArtifactName>();

  for (const name of JSONL_ARTIFACT_NAMES) {
    const rows: Record<string, unknown>[] = [];
    const result = await readJsonLines(
      path.join(planDir, name),
      name,
      (value) => {
        const row = validators[name](value);
        if (['updates.jsonl', 'noops.jsonl', 'conflicts.jsonl'].includes(name)) {
          const id = String(row.id);
          const previous = targetIds.get(id);
          if (previous) throw new Error(`Duplicate target id ${id} in ${previous} and ${name}`);
          targetIds.set(id, name);
        }
        rows.push(row);
      },
    );
    artifactHashes[name] = result.sha256;
    artifactRows[name] = result.rows;
    rowsByArtifact.set(name, rows);
  }

  const validated = validateSbisExactPlanManifest({
    manifest,
    summary,
    artifactHashes,
    artifactRows,
  });
  const callbacks: Record<JsonlArtifactName, ((rows: Record<string, unknown>[]) => Promise<void>) | undefined> = {
    'updates.jsonl': options.onUpdateBatch,
    'noops.jsonl': options.onNoopBatch,
    'conflicts.jsonl': options.onConflictBatch,
    'skipped.jsonl': options.onSkippedBatch,
    'source-quarantine.jsonl': options.onSourceQuarantineBatch,
    'provenance.jsonl': options.onProvenanceBatch,
    'rollback.jsonl': options.onRollbackBatch,
  };
  for (const name of JSONL_ARTIFACT_NAMES) {
    const callback = callbacks[name];
    if (!callback) continue;
    const rows = rowsByArtifact.get(name) ?? [];
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      await callback(name === 'updates.jsonl' ? batch.map(applyUpdate) : batch);
    }
  }

  return {
    manifest,
    summary,
    planFingerprint: validated.planFingerprint,
    updateRows: artifactRows['updates.jsonl'],
    noopRows: artifactRows['noops.jsonl'],
    conflictRows: artifactRows['conflicts.jsonl'],
    skippedRows: artifactRows['skipped.jsonl'],
    sourceQuarantinedRows: artifactRows['source-quarantine.jsonl'],
    provenanceRows: artifactRows['provenance.jsonl'],
    rollbackRows: artifactRows['rollback.jsonl'],
    artifactHashes,
  };
}
