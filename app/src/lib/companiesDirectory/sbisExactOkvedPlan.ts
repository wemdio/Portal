import {
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';
import {
  validateFnsInn,
  validateFnsOgrn,
  validateFnsOkvedCode,
  type FnsSmeTaxpayerType,
} from '@/lib/companiesDirectory/fnsSmeXml';

export const SBIS_EXACT_OKVED_SOURCE = 'sbis_registry' as const;

export interface SbisExactOkvedSourceRow {
  inn: unknown;
  ogrn: unknown;
  okved_code_exact: unknown;
  source_file: unknown;
  source_sha256: unknown;
  row_number: unknown;
}

export interface SbisExactOkvedTargetRow {
  id: string | number;
  inn: unknown;
  ogrn: unknown;
  okved_code_exact: unknown;
  okved_exact_source: unknown;
}

export interface SbisExactOkvedUpdate {
  id: string;
  inn: string;
  expected_ogrn: string;
  registry_ogrn: string;
  match_method: 'ogrn_inn';
  okved_code_exact: string;
  okved_exact_source: typeof SBIS_EXACT_OKVED_SOURCE;
}

export interface SbisExactOkvedNoop {
  id: string;
  inn: string;
  expected_ogrn: string;
  registry_ogrn: string;
  match_method: 'ogrn_inn';
  reason: 'already_exact';
}

export interface SbisExactOkvedConflict {
  id: string;
  inn: string;
  expected_ogrn: string;
  registry_ogrn: string;
  match_method: 'ogrn_inn';
  kind: 'existing_exact_preserved' | 'partial_existing_exact_state';
  existing_okved_code_exact: string | null;
  existing_okved_exact_source: string | null;
  incoming_okved_code_exact: string;
  incoming_okved_exact_source: typeof SBIS_EXACT_OKVED_SOURCE;
}

export interface SbisExactOkvedSkipped {
  inn: string;
  registry_ogrn: string;
  reason:
    | 'target_identity_not_found'
    | 'ambiguous_target_inn'
    | 'ambiguous_target_identity';
  target_ids?: string[];
}

export interface SbisExactSourceEvidence {
  source_file: string;
  sha256: string;
  rowNumbers: number[];
}

export interface SbisExactOkvedProvenance {
  action: 'update';
  id: string;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
  sources: SbisExactSourceEvidence[];
}

export interface SbisExactSourceQuarantineRow {
  inn: string;
  ogrn: string;
  okved_code_exact?: string;
  okved_codes?: string[];
  reason:
    | 'invalid_source_inn'
    | 'invalid_source_ogrn'
    | 'invalid_source_provenance'
    | 'invalid_okved_code'
    | 'okved_not_in_reference'
    | 'conflicting_source_ogrn'
    | 'conflicting_source_okved'
    | 'identity_has_quarantined_source_row';
  validation_error?: string;
  sources: SbisExactSourceEvidence[];
}

export interface SbisExactOkvedPlanMetrics {
  source_rows: number;
  unique_source_identities: number;
  duplicate_source_rows: number;
  matched_directory_rows: number;
  updates: number;
  noops: number;
  conflicts: number;
  skipped: number;
  source_quarantined: number;
  invalid_identity_quarantined: number;
  invalid_provenance_quarantined: number;
  invalid_okved_quarantined: number;
  reference_missing_quarantined: number;
  conflicting_source_ogrn_inns: number;
  conflicting_source_identities: number;
  ambiguous_target_inns: number;
  ambiguous_target_identities: number;
  inserts: 0;
}

export interface SbisExactOkvedPlan {
  source: typeof SBIS_EXACT_OKVED_SOURCE;
  updates: SbisExactOkvedUpdate[];
  noops: SbisExactOkvedNoop[];
  conflicts: SbisExactOkvedConflict[];
  skipped: SbisExactOkvedSkipped[];
  sourceQuarantine: SbisExactSourceQuarantineRow[];
  provenance: SbisExactOkvedProvenance[];
  metrics: SbisExactOkvedPlanMetrics;
  fingerprint: string;
}

interface NormalizedSourceRow {
  inputIndex: number;
  inn: string;
  ogrn: string;
  code: string;
  sourceFile: string;
  sourceSha256: string;
  rowNumber: number;
}

interface SourceIdentity {
  inn: string;
  ogrn: string;
  rows: NormalizedSourceRow[];
  codes: Set<string>;
}

interface NormalizedTargetRow {
  id: string;
  inn: string;
  ogrn: string;
  okvedCodeExact: string | null;
  okvedExactSource: string | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumericText(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    if (left.length !== right.length) return left.length - right.length;
  }
  return compareText(left, right);
}

function identityKey(inn: string, ogrn: string): string {
  return `${inn}\u0000${ogrn}`;
}

function taxpayerType(inn: string): FnsSmeTaxpayerType {
  return inn.length === 10
    ? 'legal_entity'
    : 'individual_entrepreneur';
}

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evidence(rows: readonly NormalizedSourceRow[]): SbisExactSourceEvidence[] {
  const grouped = new Map<string, {
    sourceFile: string;
    sha256: string;
    rowNumbers: Set<number>;
  }>();
  for (const row of rows) {
    const key = `${row.sourceFile}\u0000${row.sourceSha256}`;
    const current = grouped.get(key) ?? {
      sourceFile: row.sourceFile,
      sha256: row.sourceSha256,
      rowNumbers: new Set<number>(),
    };
    current.rowNumbers.add(row.rowNumber);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .sort((left, right) =>
      compareText(left.sourceFile, right.sourceFile)
      || compareText(left.sha256, right.sha256))
    .map((item) => ({
      source_file: item.sourceFile,
      sha256: item.sha256,
      rowNumbers: [...item.rowNumbers].sort((left, right) => left - right),
    }));
}

function singleRowEvidence(input: {
  sourceFile: string;
  sourceSha256: string;
  rowNumber: number;
}): SbisExactSourceEvidence[] {
  if (
    !input.sourceFile
    || !/^[a-f0-9]{64}$/.test(input.sourceSha256)
    || !Number.isSafeInteger(input.rowNumber)
    || input.rowNumber < 1
  ) {
    return [];
  }
  return [{
    source_file: input.sourceFile,
    sha256: input.sourceSha256,
    rowNumbers: [input.rowNumber],
  }];
}

function quarantineSortKey(row: SbisExactSourceQuarantineRow): string {
  return [
    row.inn,
    row.ogrn,
    row.reason,
    row.okved_code_exact ?? '',
    (row.okved_codes ?? []).join(','),
    canonicalJson(row.sources),
  ].join('\u0000');
}

/**
 * Builds an update-only exact OKVED plan from purchased SBIS registry files.
 * A target is eligible only when both INN and OGRN match and both exact fields
 * are NULL. Source ambiguity is audited instead of guessed through.
 */
export function buildSbisExactOkvedPlan(
  sourceRows: readonly SbisExactOkvedSourceRow[],
  existingRows: readonly SbisExactOkvedTargetRow[],
  referenceCodes: ReadonlySet<string>,
): SbisExactOkvedPlan {
  const identities = new Map<string, SourceIdentity>();
  const sourceQuarantine: SbisExactSourceQuarantineRow[] = [];
  const quarantinedInputIndexes = new Set<number>();
  const blockedIdentities = new Set<string>();
  const identityRowsByInn = new Map<string, NormalizedSourceRow[]>();
  const validRowCountsByIdentityAndCode = new Map<string, number>();
  let invalidIdentityQuarantined = 0;
  let invalidProvenanceQuarantined = 0;
  let invalidOkvedQuarantined = 0;
  let referenceMissingQuarantined = 0;

  for (const [inputIndex, raw] of sourceRows.entries()) {
    const inn = text(raw.inn);
    const ogrn = text(raw.ogrn);
    const code = text(raw.okved_code_exact);
    const sourceFile = text(raw.source_file);
    const sourceSha256 = text(raw.source_sha256).toLowerCase();
    const rowNumber = typeof raw.row_number === 'number'
      ? raw.row_number
      : Number.NaN;
    const sourceEvidence = singleRowEvidence({
      sourceFile,
      sourceSha256,
      rowNumber,
    });

    let type: FnsSmeTaxpayerType;
    try {
      type = taxpayerType(inn);
      validateFnsInn(inn, type);
    } catch (error) {
      invalidIdentityQuarantined += 1;
      quarantinedInputIndexes.add(inputIndex);
      sourceQuarantine.push({
        inn,
        ogrn,
        okved_code_exact: code,
        reason: 'invalid_source_inn',
        validation_error: validationMessage(error),
        sources: sourceEvidence,
      });
      continue;
    }
    try {
      validateFnsOgrn(ogrn, type);
    } catch (error) {
      invalidIdentityQuarantined += 1;
      quarantinedInputIndexes.add(inputIndex);
      sourceQuarantine.push({
        inn,
        ogrn,
        okved_code_exact: code,
        reason: 'invalid_source_ogrn',
        validation_error: validationMessage(error),
        sources: sourceEvidence,
      });
      continue;
    }

    const key = identityKey(inn, ogrn);
    if (sourceEvidence.length === 0) {
      invalidProvenanceQuarantined += 1;
      quarantinedInputIndexes.add(inputIndex);
      blockedIdentities.add(key);
      sourceQuarantine.push({
        inn,
        ogrn,
        okved_code_exact: code,
        reason: 'invalid_source_provenance',
        sources: [],
      });
      continue;
    }
    const row: NormalizedSourceRow = {
      inputIndex,
      inn,
      ogrn,
      code,
      sourceFile,
      sourceSha256,
      rowNumber,
    };
    const innIdentityRows = identityRowsByInn.get(inn) ?? [];
    innIdentityRows.push(row);
    identityRowsByInn.set(inn, innIdentityRows);
    try {
      validateFnsOkvedCode(code);
    } catch (error) {
      invalidOkvedQuarantined += 1;
      quarantinedInputIndexes.add(inputIndex);
      blockedIdentities.add(key);
      sourceQuarantine.push({
        inn,
        ogrn,
        okved_code_exact: code,
        reason: 'invalid_okved_code',
        validation_error: validationMessage(error),
        sources: sourceEvidence,
      });
      continue;
    }
    if (!referenceCodes.has(code)) {
      referenceMissingQuarantined += 1;
      quarantinedInputIndexes.add(inputIndex);
      blockedIdentities.add(key);
      sourceQuarantine.push({
        inn,
        ogrn,
        okved_code_exact: code,
        reason: 'okved_not_in_reference',
        sources: sourceEvidence,
      });
      continue;
    }

    const identity = identities.get(key) ?? {
      inn,
      ogrn,
      rows: [],
      codes: new Set<string>(),
    };
    identity.rows.push(row);
    identity.codes.add(code);
    identities.set(key, identity);
    const codeKey = `${key}\u0000${code}`;
    validRowCountsByIdentityAndCode.set(
      codeKey,
      (validRowCountsByIdentityAndCode.get(codeKey) ?? 0) + 1,
    );
  }

  const targetsByIdentity = new Map<string, NormalizedTargetRow[]>();
  const targetsByInn = new Map<string, NormalizedTargetRow[]>();
  const seenTargetIds = new Set<string>();
  for (const raw of existingRows) {
    const id = String(raw.id);
    if (!/^\d+$/.test(id) || BigInt(id) < BigInt(1)) {
      throw new Error(`Invalid existing company id: ${id}`);
    }
    if (seenTargetIds.has(id)) {
      throw new Error(`Duplicate existing company id: ${id}`);
    }
    seenTargetIds.add(id);
    const inn = text(raw.inn);
    const ogrn = text(raw.ogrn);
    if (!inn) continue;
    const target: NormalizedTargetRow = {
      id,
      inn,
      ogrn,
      okvedCodeExact: nullableText(raw.okved_code_exact),
      okvedExactSource: nullableText(raw.okved_exact_source),
    };
    const innTargets = targetsByInn.get(inn) ?? [];
    innTargets.push(target);
    targetsByInn.set(inn, innTargets);
    if (!ogrn) continue;
    const key = identityKey(inn, ogrn);
    const rows = targetsByIdentity.get(key) ?? [];
    rows.push(target);
    targetsByIdentity.set(key, rows);
  }
  for (const rows of [
    ...targetsByInn.values(),
    ...targetsByIdentity.values(),
  ]) {
    rows.sort((left, right) => compareNumericText(left.id, right.id));
  }

  const updates: SbisExactOkvedUpdate[] = [];
  const noops: SbisExactOkvedNoop[] = [];
  const conflicts: SbisExactOkvedConflict[] = [];
  const skipped: SbisExactOkvedSkipped[] = [];
  const provenance: SbisExactOkvedProvenance[] = [];
  let conflictingSourceIdentities = 0;
  let matchedDirectoryRows = 0;
  let ambiguousTargetIdentities = 0;
  const ambiguousTargetInns = new Set<string>();
  const conflictingSourceOgrnInns = new Set(
    [...identityRowsByInn.entries()]
      .filter(([, rows]) => new Set(rows.map((row) => row.ogrn)).size > 1)
      .map(([inn]) => inn),
  );

  const sortedIdentities = [...identities.entries()]
    .sort(([left], [right]) => compareText(left, right));
  for (const [key, identity] of sortedIdentities) {
    const sources = evidence(identity.rows);
    if (conflictingSourceOgrnInns.has(identity.inn)) {
      for (const row of identity.rows) quarantinedInputIndexes.add(row.inputIndex);
      sourceQuarantine.push({
        inn: identity.inn,
        ogrn: identity.ogrn,
        okved_codes: [...identity.codes].sort(compareText),
        reason: 'conflicting_source_ogrn',
        sources,
      });
      continue;
    }
    if (blockedIdentities.has(key)) {
      for (const row of identity.rows) quarantinedInputIndexes.add(row.inputIndex);
      sourceQuarantine.push({
        inn: identity.inn,
        ogrn: identity.ogrn,
        okved_codes: [...identity.codes].sort(compareText),
        reason: 'identity_has_quarantined_source_row',
        sources,
      });
      continue;
    }
    if (identity.codes.size !== 1) {
      conflictingSourceIdentities += 1;
      for (const row of identity.rows) quarantinedInputIndexes.add(row.inputIndex);
      sourceQuarantine.push({
        inn: identity.inn,
        ogrn: identity.ogrn,
        okved_codes: [...identity.codes].sort(compareText),
        reason: 'conflicting_source_okved',
        sources,
      });
      continue;
    }

    const code = [...identity.codes][0];
    const innTargets = targetsByInn.get(identity.inn) ?? [];
    if (innTargets.length > 1) {
      ambiguousTargetInns.add(identity.inn);
      skipped.push({
        inn: identity.inn,
        registry_ogrn: identity.ogrn,
        reason: 'ambiguous_target_inn',
        target_ids: innTargets.map((target) => target.id),
      });
      continue;
    }
    const targets = targetsByIdentity.get(key) ?? [];
    if (targets.length === 0) {
      skipped.push({
        inn: identity.inn,
        registry_ogrn: identity.ogrn,
        reason: 'target_identity_not_found',
      });
      continue;
    }
    if (targets.length !== 1) {
      ambiguousTargetIdentities += 1;
      skipped.push({
        inn: identity.inn,
        registry_ogrn: identity.ogrn,
        reason: 'ambiguous_target_identity',
        target_ids: targets.map((target) => target.id),
      });
      continue;
    }

    matchedDirectoryRows += 1;
    const target = targets[0];
    const identityFields = {
      id: target.id,
      inn: identity.inn,
      expected_ogrn: target.ogrn,
      registry_ogrn: identity.ogrn,
      match_method: 'ogrn_inn' as const,
    };
    const hasCode = target.okvedCodeExact !== null;
    const hasSource = target.okvedExactSource !== null;
    if (!hasCode && !hasSource) {
      updates.push({
        ...identityFields,
        okved_code_exact: code,
        okved_exact_source: SBIS_EXACT_OKVED_SOURCE,
      });
      provenance.push({
        action: 'update',
        id: target.id,
        inn: identity.inn,
        ogrn: identity.ogrn,
        okved_code_exact: code,
        sources,
      });
    } else if (hasCode !== hasSource) {
      conflicts.push({
        ...identityFields,
        kind: 'partial_existing_exact_state',
        existing_okved_code_exact: target.okvedCodeExact,
        existing_okved_exact_source: target.okvedExactSource,
        incoming_okved_code_exact: code,
        incoming_okved_exact_source: SBIS_EXACT_OKVED_SOURCE,
      });
    } else if (target.okvedCodeExact === code) {
      noops.push({
        ...identityFields,
        reason: 'already_exact',
      });
    } else {
      conflicts.push({
        ...identityFields,
        kind: 'existing_exact_preserved',
        existing_okved_code_exact: target.okvedCodeExact,
        existing_okved_exact_source: target.okvedExactSource,
        incoming_okved_code_exact: code,
        incoming_okved_exact_source: SBIS_EXACT_OKVED_SOURCE,
      });
    }
  }

  const byId = <T extends { id: string }>(left: T, right: T) =>
    compareNumericText(left.id, right.id);
  updates.sort(byId);
  noops.sort(byId);
  conflicts.sort(byId);
  provenance.sort(byId);
  skipped.sort((left, right) =>
    compareText(identityKey(left.inn, left.registry_ogrn), identityKey(
      right.inn,
      right.registry_ogrn,
    )));
  sourceQuarantine.sort((left, right) =>
    compareText(quarantineSortKey(left), quarantineSortKey(right)));

  const duplicateSourceRows = [...validRowCountsByIdentityAndCode.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const metrics: SbisExactOkvedPlanMetrics = {
    source_rows: sourceRows.length,
    unique_source_identities: identities.size,
    duplicate_source_rows: duplicateSourceRows,
    matched_directory_rows: matchedDirectoryRows,
    updates: updates.length,
    noops: noops.length,
    conflicts: conflicts.length,
    skipped: skipped.length,
    source_quarantined: quarantinedInputIndexes.size,
    invalid_identity_quarantined: invalidIdentityQuarantined,
    invalid_provenance_quarantined: invalidProvenanceQuarantined,
    invalid_okved_quarantined: invalidOkvedQuarantined,
    reference_missing_quarantined: referenceMissingQuarantined,
    conflicting_source_ogrn_inns: conflictingSourceOgrnInns.size,
    conflicting_source_identities: conflictingSourceIdentities,
    ambiguous_target_inns: ambiguousTargetInns.size,
    ambiguous_target_identities: ambiguousTargetIdentities,
    inserts: 0,
  };
  const fingerprintBody: Omit<SbisExactOkvedPlan, 'fingerprint'> = {
    source: SBIS_EXACT_OKVED_SOURCE,
    updates,
    noops,
    conflicts,
    skipped,
    sourceQuarantine,
    provenance,
    metrics,
  };
  return {
    ...fingerprintBody,
    fingerprint: sha256Hex(canonicalJson(fingerprintBody)),
  };
}
