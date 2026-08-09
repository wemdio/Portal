import {
  SBIS_APPROXIMATE_OKVED_BY_ACTIVITY,
  normalizeSbisInn,
} from '@/lib/companiesDirectory/sbisImportPlan';
import {
  normalizeStrictContactList,
  type StrictContactField,
} from '@/lib/companiesDirectory/contactPolicy';
import { getOkvedByCode } from '@/lib/companiesSearch/okved2';
import {
  assertPortalProductionTarget,
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';

const CURRENT_PRODUCTION_HOST = '139.60.162.12';
const CURRENT_PRODUCTION_PORT = 35434;
const CURRENT_PRODUCTION_DATABASE = 'postgres';
const POSTGRES_BIGINT_MAX = BigInt('9223372036854775807');

export const TRUSTED_SBIS_V4_PLAN_FINGERPRINT =
  'd36c06f13f09ac9f6ad3c26102b9c29dd87cf83ecd79dd7b2cf5c7068d87ba08';

const SBIS_V4_PLAN = 'sbis-directory-v4';
const POLZA_REGISTRY_PLAN = 'polza-registry-v1';
export const POLZA_REGISTRY_V2_PLAN = 'polza-registry-v2';

export const TRUSTED_SBIS_PLAN_FINGERPRINTS = Object.freeze({
  [SBIS_V4_PLAN]: TRUSTED_SBIS_V4_PLAN_FINGERPRINT,
  [POLZA_REGISTRY_PLAN]:
    '5d2b2691b2e914f3ba854f60789055a45064aad167cfd5f3295182ac1cf77606',
  [POLZA_REGISTRY_V2_PLAN]:
    'ae5064cd70dbb29c023bc34572211e0b6d69ef171c03704c7fba57cafba4fb00',
});

type TrustedSbisPlan = keyof typeof TRUSTED_SBIS_PLAN_FINGERPRINTS;

const INSERT_FIELDS = [
  'name',
  'inn',
  'kpp',
  'address',
  'director_last_name',
  'director_first_name',
  'director_middle_name',
  'activity_type',
  'employees_count',
  'phones',
  'email',
  'revenue',
  'cost',
  'edo_id',
  'okpo',
  'pf_reg_number',
  'branch_code',
  'website',
  'egais',
  'gln',
  'ogrn',
  'region_code',
  'okved_code',
  'okved_code_exact',
  'okved_exact_source',
  'source_file',
] as const;

export const SBIS_FILL_EMPTY_FIELDS = [
  'phones',
  'email',
  'website',
  'okved_code',
] as const;

export const SBIS_BEFORE_IMAGE_FIELDS = [
  ...SBIS_FILL_EMPTY_FIELDS,
] as const;

const POLZA_REGISTRY_FILL_EMPTY_FIELDS = [
  'website',
  'email',
] as const;

const POLZA_REGISTRY_V2_FILL_EMPTY_FIELDS = [
  'phones',
  'website',
  'email',
] as const;

export const POLZA_REGISTRY_V2_REQUIRED_AUDIT_ARTIFACTS = [
  'skipped.jsonl',
  'conflicts.jsonl',
  'provenance.jsonl',
  'source-locations.jsonl',
  'source-archives.jsonl',
  'filtered-status.jsonl',
  'rollback.jsonl',
] as const;

type SbisFillEmptyField = typeof SBIS_FILL_EMPTY_FIELDS[number];
type JsonRecord = Record<string, unknown>;

interface SbisHashedArtifact {
  sha256: string;
}

interface SbisHashedRowsArtifact extends SbisHashedArtifact {
  rows: number;
}

export interface SbisPlanManifest {
  version: 1;
  plan: string;
  target: {
    host: string;
    port: number;
    database: string;
  };
  sources: Array<{
    sourceFile: string;
    sha256: string;
    inputRows: number;
    uniqueInns: number;
  }>;
  artifacts: {
    'summary.json': SbisHashedArtifact;
    'inserts.jsonl': SbisHashedRowsArtifact;
    'updates.jsonl': SbisHashedRowsArtifact;
    'rejected.jsonl': SbisHashedRowsArtifact;
    'skipped.jsonl'?: SbisHashedRowsArtifact;
    'conflicts.jsonl'?: SbisHashedRowsArtifact;
    'provenance.jsonl'?: SbisHashedRowsArtifact;
    'source-locations.jsonl'?: SbisHashedRowsArtifact;
    'source-archives.jsonl'?: SbisHashedRowsArtifact;
    'filtered-status.jsonl'?: SbisHashedRowsArtifact;
    'rollback.jsonl'?: SbisHashedRowsArtifact;
  };
  expected: {
    inputRows: number;
    uniqueIncomingInns: number;
    inserts: number;
    updates: number;
    skipped: number;
    rejectedRows: number;
    approximateOkvedCounts: Record<string, number>;
  };
}

export interface SbisPlanValidationInput {
  manifest: SbisPlanManifest;
  summary: unknown;
  artifactHashes: Record<string, string>;
  artifactRows: Record<string, number>;
  approximateOkvedCounts: Record<string, number>;
}

export interface SbisPlanValidationResult {
  planFingerprint: string;
}

export interface SbisImportPreviewBody {
  stagedInserts: number;
  stagedUpdates: number;
  missingInserts: number;
  alreadyPresentInserts: number;
  rowsToUpdate: number;
  missingUpdateTargets: number;
  duplicateTargetInns: number;
  conflictingPresentInserts: number;
  mismatchedUpdateTargets: number;
  conflictingUpdateValues: number;
  stateDigest: string;
}

export interface SbisImportPreview extends SbisImportPreviewBody {
  fingerprint: string;
}

export interface SbisApplySession {
  beginReadOnly(): Promise<void>;
  beginReadWrite(): Promise<void>;
  acquireAdvisoryLock(): Promise<void>;
  stageArtifacts(): Promise<void>;
  lockTargetTable(): Promise<void>;
  preview(): Promise<SbisImportPreview>;
  insertMissing(): Promise<number>;
  fillEmpty(): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface SbisApplyResult {
  inserted: number;
  updated: number;
  alreadyApplied: boolean;
  before: SbisImportPreview;
  after: SbisImportPreview;
}

export interface SbisApplyAuditHooks {
  plan: string;
  planFingerprint: string;
  captureBeforeImage(input: {
    before: SbisImportPreview;
  }): Promise<unknown>;
  persistPendingReceipt(input: {
    plan: string;
    planFingerprint: string;
    beforeImage: unknown;
    inserted: number;
    updated: number;
    before: SbisImportPreview;
    after: SbisImportPreview;
  }): Promise<void>;
}

export interface SbisApplyCliArgs {
  mode: 'check' | 'apply';
  planDir: string;
  manifestPath?: string;
  confirmedPlanFingerprint?: string;
  confirmedPreviewFingerprint?: string;
  confirmedTarget?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function isBlank(value: unknown): boolean {
  return (
    value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '')
  );
}

function assertCanonicalRegistryV2Contact(
  value: unknown,
  label: string,
  field: StrictContactField,
): void {
  if (value === null) return;
  if (typeof value !== 'string' || isBlank(value)) {
    throw new Error(`${label} contains an invalid ${field} list`);
  }
  const normalized = normalizeStrictContactList(field, value);
  if (!normalized || normalized !== value) {
    throw new Error(`${label} ${field} must use canonical strict format`);
  }
}

function assertExactKeys(
  value: JsonRecord,
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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `${label} mismatch: expected ${canonicalJson(expected)}, got ${canonicalJson(actual)}`,
    );
  }
}

function readSummaryShape(summary: unknown): {
  inputFiles: unknown[];
  combined: JsonRecord;
  idempotency: JsonRecord;
} {
  assertRecord(summary, 'summary.json');
  if (summary.dryRunOnly !== true) {
    throw new Error('summary.json is not marked dryRunOnly');
  }
  if (
    summary.mode !== 'contact-only'
    && summary.mode !== 'strict-contact'
    && summary.mode !== 'registry-v2'
  ) {
    throw new Error(
      'summary.json mode must be contact-only, strict-contact or registry-v2',
    );
  }
  assertRecord(summary.input, 'summary.input');
  if (!Array.isArray(summary.input.files)) {
    throw new Error('summary.input.files must be an array');
  }
  assertRecord(summary.combined, 'summary.combined');
  assertRecord(summary.idempotencyCheck, 'summary.idempotencyCheck');
  if (
    summary.idempotencyCheck.passed !== true
    || summary.idempotencyCheck.repeatedInserts !== 0
    || summary.idempotencyCheck.repeatedUpdates !== 0
  ) {
    throw new Error('summary idempotency check did not pass');
  }
  return {
    inputFiles: summary.input.files,
    combined: summary.combined,
    idempotency: summary.idempotencyCheck,
  };
}

export function buildSbisPlanFingerprint(
  manifest: SbisPlanManifest,
): string {
  return sha256Hex(canonicalJson(manifest));
}

function assertSupportedSbisPlan(
  plan: string,
): asserts plan is TrustedSbisPlan {
  if (
    !Object.prototype.hasOwnProperty.call(
      TRUSTED_SBIS_PLAN_FINGERPRINTS,
      plan,
    )
  ) {
    throw new Error(`SBIS plan is not trusted: ${plan}`);
  }
}

export function assertTrustedSbisPlanFingerprint(
  plan: string,
  planFingerprint: string,
): void {
  assertSupportedSbisPlan(plan);
  assertSha256(planFingerprint, 'SBIS plan fingerprint');
  if (
    planFingerprint.toLowerCase()
    !== TRUSTED_SBIS_PLAN_FINGERPRINTS[plan]
  ) {
    throw new Error(`SBIS plan fingerprint is not trusted for ${plan}`);
  }
}

export function assertTrustedSbisV4PlanFingerprint(
  planFingerprint: string,
): void {
  try {
    assertTrustedSbisPlanFingerprint(SBIS_V4_PLAN, planFingerprint);
  } catch {
    throw new Error(
      'SBIS apply is restricted to the trusted frozen v4 manifest',
    );
  }
}

export function validateSbisPlanManifest(
  input: SbisPlanValidationInput,
): SbisPlanValidationResult {
  const { manifest } = input;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported SBIS manifest version: ${manifest.version}`);
  }
  if (!manifest.plan.trim()) {
    throw new Error('SBIS manifest plan name is empty');
  }
  if (manifest.plan === POLZA_REGISTRY_V2_PLAN) {
    for (const artifactName of POLZA_REGISTRY_V2_REQUIRED_AUDIT_ARTIFACTS) {
      if (!(artifactName in manifest.artifacts)) {
        throw new Error(
          `Registry v2 manifest is missing required artifact ${artifactName}`,
        );
      }
    }
  }
  assertEqual(
    manifest.target,
    {
      host: CURRENT_PRODUCTION_HOST,
      port: CURRENT_PRODUCTION_PORT,
      database: CURRENT_PRODUCTION_DATABASE,
    },
    'manifest target',
  );

  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    assertSha256(artifact.sha256, `manifest ${name} hash`);
    const actualHash = input.artifactHashes[name];
    assertSha256(actualHash, `actual ${name} hash`);
    if (artifact.sha256.toLowerCase() !== actualHash.toLowerCase()) {
      throw new Error(`${name} SHA-256 mismatch`);
    }
    if ('rows' in artifact) {
      const actualRows = input.artifactRows[name];
      if (artifact.rows !== actualRows) {
        throw new Error(
          `${name} row count mismatch: expected ${artifact.rows}, got ${actualRows}`,
        );
      }
    }
  }

  const { inputFiles, combined } = readSummaryShape(input.summary);
  const normalizedSummarySources = inputFiles.map((raw, index) => {
    assertRecord(raw, `summary.input.files[${index}]`);
    return {
      sourceFile: raw.sourceFile,
      sha256: raw.sha256,
      inputRows: raw.inputRows,
      uniqueInns: raw.uniqueInns,
    };
  });
  assertEqual(normalizedSummarySources, manifest.sources, 'source manifest');

  const expectedCombined = {
    inputRows: manifest.expected.inputRows,
    uniqueIncomingInns: manifest.expected.uniqueIncomingInns,
    inserts: manifest.expected.inserts,
    updates: manifest.expected.updates,
    skipped: manifest.expected.skipped,
    rejectedRows: manifest.expected.rejectedRows,
  };
  const actualCombined = Object.fromEntries(
    Object.keys(expectedCombined).map((key) => [key, combined[key]]),
  );
  assertEqual(actualCombined, expectedCombined, 'summary combined counts');

  assertEqual(
    input.approximateOkvedCounts,
    manifest.expected.approximateOkvedCounts,
    'approximate OKVED counts',
  );
  const summaryOkvedCounts = Array.isArray(combined.approximateOkvedCounts)
    ? Object.fromEntries(combined.approximateOkvedCounts as Array<[string, number]>)
    : null;
  assertEqual(
    summaryOkvedCounts,
    manifest.expected.approximateOkvedCounts,
    'summary approximate OKVED counts',
  );

  if (
    input.artifactRows['inserts.jsonl'] !== manifest.expected.inserts
    || input.artifactRows['updates.jsonl'] !== manifest.expected.updates
    || input.artifactRows['rejected.jsonl'] !== manifest.expected.rejectedRows
  ) {
    throw new Error('Artifact row counts do not match frozen expected counts');
  }

  return {
    planFingerprint: buildSbisPlanFingerprint(manifest),
  };
}

export function validateSbisInsertRow(
  value: unknown,
  plan: string = SBIS_V4_PLAN,
): JsonRecord {
  assertSupportedSbisPlan(plan);
  assertRecord(value, 'SBIS insert row');
  assertExactKeys(value, INSERT_FIELDS, 'SBIS insert row');

  const normalizedInn = normalizeSbisInn(value.inn);
  if (normalizedInn === null || normalizedInn !== value.inn) {
    throw new Error(`Invalid or non-normalized INN: ${String(value.inn)}`);
  }
  if (isBlank(value.website) && isBlank(value.email)) {
    throw new Error(`SBIS insert ${normalizedInn} must have a website or email`);
  }
  if (plan === POLZA_REGISTRY_PLAN && value.phones !== null) {
    throw new Error(
      `SBIS insert ${normalizedInn} contains forbidden phones`,
    );
  }
  if (plan === POLZA_REGISTRY_V2_PLAN) {
    for (const field of POLZA_REGISTRY_V2_FILL_EMPTY_FIELDS) {
      assertCanonicalRegistryV2Contact(
        value[field],
        `SBIS insert ${normalizedInn}`,
        field,
      );
    }
  }
  if (
    value.okved_code_exact !== null
    || value.okved_exact_source !== null
  ) {
    throw new Error(`SBIS insert ${normalizedInn} must not contain exact OKVED`);
  }
  if (
    typeof value.activity_type !== 'string'
    || typeof value.okved_code !== 'string'
  ) {
    throw new Error(`SBIS insert ${normalizedInn} has no approximate OKVED mapping`);
  }
  if (
    plan === POLZA_REGISTRY_PLAN
    || plan === POLZA_REGISTRY_V2_PLAN
  ) {
    if (
      isBlank(value.activity_type)
      || !/^\d{2}$/.test(value.okved_code)
      || !getOkvedByCode(value.okved_code)
    ) {
      throw new Error(
        `SBIS insert ${normalizedInn} has an invalid parent OKVED mapping`,
      );
    }
  } else {
    const expectedCode = (
      SBIS_APPROXIMATE_OKVED_BY_ACTIVITY as Record<string, string>
    )[value.activity_type];
    if (!expectedCode || value.okved_code !== expectedCode) {
      throw new Error(
        `SBIS insert ${normalizedInn} has an invalid approximate OKVED mapping`,
      );
    }
  }
  if (
    value.region_code !== null
    && (
      typeof value.region_code !== 'string'
      || !/^\d{2}$/.test(value.region_code)
    )
  ) {
    throw new Error(`SBIS insert ${normalizedInn} has an invalid region_code`);
  }
  if (typeof value.source_file !== 'string' || isBlank(value.source_file)) {
    throw new Error(`SBIS insert ${normalizedInn} has no source_file`);
  }
  for (const field of ['employees_count', 'revenue', 'cost'] as const) {
    const fieldValue = value[field];
    if (
      fieldValue !== null
      && (
        typeof fieldValue !== 'number'
        || !Number.isSafeInteger(fieldValue)
        || fieldValue < 0
        || (field === 'employees_count' && fieldValue > 2_147_483_647)
      )
    ) {
      throw new Error(
        `SBIS insert ${normalizedInn} has an invalid ${field}`,
      );
    }
  }

  return value;
}

export function validateSbisUpdateRow(
  value: unknown,
  plan: string = SBIS_V4_PLAN,
): JsonRecord {
  assertSupportedSbisPlan(plan);
  assertRecord(value, 'SBIS update row');
  assertExactKeys(value, ['id', 'inn', 'patch'], 'SBIS update row');
  const normalizedInn = normalizeSbisInn(value.inn);
  if (normalizedInn === null || normalizedInn !== value.inn) {
    throw new Error(`Invalid or non-normalized INN: ${String(value.inn)}`);
  }
  const auditId = String(value.id);
  if (
    !/^[1-9]\d*$/.test(auditId)
    || BigInt(auditId) > POSTGRES_BIGINT_MAX
  ) {
    throw new Error(`SBIS update ${normalizedInn} has an invalid audit id`);
  }
  assertRecord(value.patch, `SBIS update ${normalizedInn} patch`);
  const patchKeys = Object.keys(value.patch);
  if (patchKeys.length === 0) {
    throw new Error(`SBIS update ${normalizedInn} patch is empty`);
  }
  const allowed = new Set<string>(
    plan === POLZA_REGISTRY_PLAN
      ? POLZA_REGISTRY_FILL_EMPTY_FIELDS
      : plan === POLZA_REGISTRY_V2_PLAN
        ? POLZA_REGISTRY_V2_FILL_EMPTY_FIELDS
        : SBIS_FILL_EMPTY_FIELDS,
  );
  for (const field of patchKeys) {
    if (!allowed.has(field)) {
      throw new Error(
        `SBIS update ${normalizedInn} contains forbidden field ${field}`,
      );
    }
    if (typeof value.patch[field] !== 'string' || isBlank(value.patch[field])) {
      throw new Error(
        `SBIS update ${normalizedInn} contains an empty ${field}`,
      );
    }
  }
  if (plan === POLZA_REGISTRY_V2_PLAN) {
    for (const field of patchKeys as RegistryV2ContactField[]) {
      assertCanonicalRegistryV2Contact(
        value.patch[field],
        `SBIS update ${normalizedInn}`,
        field,
      );
    }
  }
  if (
    'okved_code' in value.patch
    && !['62.0', '46.51'].includes(String(value.patch.okved_code))
  ) {
    throw new Error(
      `SBIS update ${normalizedInn} has an invalid approximate OKVED`,
    );
  }
  return value;
}

export function computeSbisFillEmptyPatch(
  existing: JsonRecord,
  candidate: JsonRecord,
): Partial<Record<SbisFillEmptyField, string>> {
  const patch: Partial<Record<SbisFillEmptyField, string>> = {};
  for (const field of SBIS_FILL_EMPTY_FIELDS) {
    if (
      isBlank(existing[field])
      && typeof candidate[field] === 'string'
      && !isBlank(candidate[field])
    ) {
      patch[field] = candidate[field].trim();
    }
  }
  return patch;
}

export function shouldFinalizeSbisApplyReceipt(
  result: Pick<SbisApplyResult, 'alreadyApplied'>,
): boolean {
  return !result.alreadyApplied;
}

export function computeSbisPreviewFingerprint(
  preview: SbisImportPreviewBody,
): string {
  return sha256Hex(canonicalJson(preview));
}

export function assertSbisApplyAuthorized(input: {
  mode: 'check' | 'apply';
  planFingerprint: string;
  confirmedPlanFingerprint?: string;
  previewFingerprint: string;
  confirmedPreviewFingerprint?: string;
}): void {
  if (input.mode !== 'apply') {
    throw new Error('Persistent writes require explicit --apply');
  }
  assertSha256(input.planFingerprint, 'plan fingerprint');
  assertSha256(input.previewFingerprint, 'preview fingerprint');
  if (
    input.confirmedPlanFingerprint?.toLowerCase()
    !== input.planFingerprint.toLowerCase()
  ) {
    throw new Error('Confirmed plan fingerprint does not match');
  }
  if (
    input.confirmedPreviewFingerprint?.toLowerCase()
    !== input.previewFingerprint.toLowerCase()
  ) {
    throw new Error('Confirmed preview fingerprint does not match');
  }
}

export function assertSbisProductionTarget(
  connectionString: string,
  confirmedTarget?: string,
): {
  host: string;
  port: number;
  database: string;
} {
  return assertPortalProductionTarget(
    connectionString,
    confirmedTarget,
    'SBIS import',
  );
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseSbisApplyCliArgs(args: string[]): SbisApplyCliArgs {
  const parsed: SbisApplyCliArgs = {
    mode: 'check',
    planDir: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      parsed.mode = 'apply';
    } else if (arg === '--check') {
      parsed.mode = 'check';
    } else if (arg === '--plan-dir') {
      parsed.planDir = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--manifest') {
      parsed.manifestPath = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--confirm-plan') {
      parsed.confirmedPlanFingerprint = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--confirm-preview') {
      parsed.confirmedPreviewFingerprint = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--confirm-target') {
      parsed.confirmedTarget = readFlagValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.planDir) {
    throw new Error('--plan-dir is required');
  }
  return parsed;
}

function assertPreviewIsStructurallySafe(preview: SbisImportPreview): void {
  if (preview.duplicateTargetInns > 0) {
    throw new Error(
      `Live target contains ${preview.duplicateTargetInns} duplicate INN actions`,
    );
  }
  if (preview.missingUpdateTargets > 0) {
    throw new Error(
      `Live target is missing ${preview.missingUpdateTargets} planned update rows`,
    );
  }
  if (preview.conflictingPresentInserts > 0) {
    throw new Error(
      `Live target has ${preview.conflictingPresentInserts} conflicting existing insert rows`,
    );
  }
  if (preview.mismatchedUpdateTargets > 0) {
    throw new Error(
      `Live target has ${preview.mismatchedUpdateTargets} update identity conflicts`,
    );
  }
  if (preview.conflictingUpdateValues > 0) {
    throw new Error(
      `Live target has ${preview.conflictingUpdateValues} conflicting update values`,
    );
  }
  if (
    preview.missingInserts
    + preview.alreadyPresentInserts
    + preview.conflictingPresentInserts
    !== preview.stagedInserts
  ) {
    throw new Error('Live preview insert classification is inconsistent');
  }
}

async function rollbackAfterFailure(
  session: SbisApplySession,
  originalError: unknown,
): Promise<never> {
  try {
    await session.rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'SBIS import failed and rollback also failed',
    );
  }
  throw originalError;
}

export async function executeSbisCheck(
  session: SbisApplySession,
): Promise<SbisImportPreview> {
  let began = false;
  try {
    await session.beginReadOnly();
    began = true;
    await session.stageArtifacts();
    const preview = await session.preview();
    assertPreviewIsStructurallySafe(preview);
    await session.rollback();
    began = false;
    return preview;
  } catch (error) {
    if (began) {
      return rollbackAfterFailure(session, error);
    }
    throw error;
  }
}

export async function executeSbisApply(
  session: SbisApplySession,
  expectedPreviewFingerprint: string,
  audit?: SbisApplyAuditHooks,
): Promise<SbisApplyResult> {
  let began = false;
  try {
    await session.beginReadWrite();
    began = true;
    await session.acquireAdvisoryLock();
    await session.stageArtifacts();
    await session.lockTargetTable();

    const before = await session.preview();
    assertPreviewIsStructurallySafe(before);
    const alreadyApplied = (
      before.missingInserts === 0
      && before.rowsToUpdate === 0
      && before.alreadyPresentInserts === before.stagedInserts
    );
    if (alreadyApplied) {
      await session.commit();
      began = false;
      return {
        inserted: 0,
        updated: 0,
        alreadyApplied: true,
        before,
        after: before,
      };
    }
    if (before.fingerprint !== expectedPreviewFingerprint.toLowerCase()) {
      throw new Error(
        'Live preview fingerprint changed; run --check again before applying',
      );
    }

    const beforeImage = audit
      ? await audit.captureBeforeImage({ before })
      : undefined;

    const inserted = await session.insertMissing();
    if (inserted !== before.missingInserts) {
      throw new Error(
        `Unexpected inserted row count: expected ${before.missingInserts}, got ${inserted}`,
      );
    }
    const updated = await session.fillEmpty();
    if (updated !== before.rowsToUpdate) {
      throw new Error(
        `Unexpected updated row count: expected ${before.rowsToUpdate}, got ${updated}`,
      );
    }

    const after = await session.preview();
    assertPreviewIsStructurallySafe(after);
    if (
      after.stagedInserts !== before.stagedInserts
      || after.stagedUpdates !== before.stagedUpdates
      || after.missingInserts !== 0
      || after.rowsToUpdate !== 0
      || after.alreadyPresentInserts !== after.stagedInserts
    ) {
      throw new Error('Post-apply verification did not reach an idempotent state');
    }

    if (audit) {
      await audit.persistPendingReceipt({
        plan: audit.plan,
        planFingerprint: audit.planFingerprint,
        beforeImage,
        inserted,
        updated,
        before,
        after,
      });
    }

    await session.commit();
    began = false;
    return {
      inserted,
      updated,
      alreadyApplied: false,
      before,
      after,
    };
  } catch (error) {
    if (began) {
      return rollbackAfterFailure(session, error);
    }
    throw error;
  }
}
