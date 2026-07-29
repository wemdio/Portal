import {
  assertPortalProductionTarget,
  assertSha256Hex,
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';

export interface FnsExactImportPreviewBody {
  stagedUpdates: number;
  rowsToUpdate: number;
  alreadyApplied: number;
  missingTargets: number;
  identityMismatches: number;
  conflictingValues: number;
  stateDigest: string;
}

export interface FnsExactImportPreview extends FnsExactImportPreviewBody {
  fingerprint: string;
}

export interface FnsExactApplySession {
  beginReadOnly(): Promise<void>;
  beginReadWrite(): Promise<void>;
  acquireAdvisoryLock(): Promise<void>;
  stageArtifacts(): Promise<void>;
  preview(): Promise<FnsExactImportPreview>;
  updateNextBatch(limit: number): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface FnsExactApplyResult {
  updated: number;
  alreadyApplied: boolean;
  before: FnsExactImportPreview;
  after: FnsExactImportPreview;
}

export interface FnsExactApplyCliArgs {
  mode: 'check' | 'apply';
  planDir: string;
  manifestPath?: string;
  confirmedPlanFingerprint?: string;
  confirmedPreviewFingerprint?: string;
  confirmedTarget?: string;
  batchSize: number;
}

export function computeFnsExactPreviewFingerprint(
  body: FnsExactImportPreviewBody,
): string {
  return sha256Hex(canonicalJson(body));
}

export function assertFnsExactApplyAuthorized(input: {
  mode: 'check' | 'apply';
  planFingerprint: string;
  confirmedPlanFingerprint?: string;
  previewFingerprint: string;
  confirmedPreviewFingerprint?: string;
}): void {
  if (input.mode !== 'apply') {
    throw new Error('Persistent writes require explicit --apply');
  }
  assertSha256Hex(input.planFingerprint, 'plan fingerprint');
  assertSha256Hex(input.previewFingerprint, 'preview fingerprint');
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

export function assertFnsProductionTarget(
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
    'FNS exact OKVED import',
  );
}

function readFlagValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseFnsExactApplyCliArgs(
  args: string[],
): FnsExactApplyCliArgs {
  const parsed: FnsExactApplyCliArgs = {
    mode: 'check',
    planDir: '',
    batchSize: 20_000,
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
    } else if (arg === '--batch-size') {
      parsed.batchSize = Number(readFlagValue(args, index, arg));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.planDir) {
    throw new Error('--plan-dir is required');
  }
  if (
    !Number.isSafeInteger(parsed.batchSize)
    || parsed.batchSize < 1
    || parsed.batchSize > 100_000
  ) {
    throw new Error('--batch-size must be between 1 and 100000');
  }
  return parsed;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid FNS preview ${label}: ${String(value)}`);
  }
}

function assertPreviewIsSafe(preview: FnsExactImportPreview): void {
  for (const field of [
    'stagedUpdates',
    'rowsToUpdate',
    'alreadyApplied',
    'missingTargets',
    'identityMismatches',
    'conflictingValues',
  ] as const) {
    assertNonNegativeInteger(preview[field], field);
  }
  assertSha256Hex(preview.stateDigest, 'FNS preview state digest');
  if (preview.missingTargets > 0) {
    throw new Error(
      `Live target is missing ${preview.missingTargets} planned rows`,
    );
  }
  if (preview.identityMismatches > 0) {
    throw new Error(
      `Live target has ${preview.identityMismatches} id/INN identity mismatches`,
    );
  }
  if (preview.conflictingValues > 0) {
    throw new Error(
      `Live target has ${preview.conflictingValues} exact OKVED conflicts`,
    );
  }
  if (
    preview.rowsToUpdate
      + preview.alreadyApplied
      + preview.missingTargets
      + preview.identityMismatches
      + preview.conflictingValues
    !== preview.stagedUpdates
  ) {
    throw new Error('FNS live preview classification is inconsistent');
  }
  if (
    computeFnsExactPreviewFingerprint({
      stagedUpdates: preview.stagedUpdates,
      rowsToUpdate: preview.rowsToUpdate,
      alreadyApplied: preview.alreadyApplied,
      missingTargets: preview.missingTargets,
      identityMismatches: preview.identityMismatches,
      conflictingValues: preview.conflictingValues,
      stateDigest: preview.stateDigest,
    }) !== preview.fingerprint.toLowerCase()
  ) {
    throw new Error('FNS live preview fingerprint is invalid');
  }
}

async function rollbackAfterFailure(
  session: FnsExactApplySession,
  originalError: unknown,
): Promise<never> {
  try {
    await session.rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'FNS exact OKVED import failed and rollback also failed',
    );
  }
  throw originalError;
}

export async function executeFnsExactCheck(
  session: FnsExactApplySession,
): Promise<FnsExactImportPreview> {
  let began = false;
  try {
    await session.beginReadOnly();
    began = true;
    await session.stageArtifacts();
    const preview = await session.preview();
    assertPreviewIsSafe(preview);
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

export async function executeFnsExactApply(
  session: FnsExactApplySession,
  expectedPreviewFingerprint: string,
  batchSize: number,
): Promise<FnsExactApplyResult> {
  if (
    !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > 100_000
  ) {
    throw new Error('FNS apply batch size must be between 1 and 100000');
  }

  let began = false;
  try {
    await session.beginReadWrite();
    began = true;
    await session.acquireAdvisoryLock();
    await session.stageArtifacts();

    const before = await session.preview();
    assertPreviewIsSafe(before);
    const isAlreadyApplied = (
      before.rowsToUpdate === 0
      && before.alreadyApplied === before.stagedUpdates
    );
    if (isAlreadyApplied) {
      await session.commit();
      began = false;
      return {
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

    let updated = 0;
    while (updated < before.rowsToUpdate) {
      const requested = Math.min(batchSize, before.rowsToUpdate - updated);
      const affected = await session.updateNextBatch(requested);
      if (
        !Number.isSafeInteger(affected)
        || affected < 1
        || affected > requested
      ) {
        throw new Error(
          `Unexpected updated row count: requested ${requested}, got ${String(affected)}`,
        );
      }
      updated += affected;
    }
    if (updated !== before.rowsToUpdate) {
      throw new Error(
        `Unexpected updated row count: expected ${before.rowsToUpdate}, got ${updated}`,
      );
    }

    const after = await session.preview();
    assertPreviewIsSafe(after);
    if (
      after.stagedUpdates !== before.stagedUpdates
      || after.rowsToUpdate !== 0
      || after.alreadyApplied !== after.stagedUpdates
    ) {
      throw new Error('FNS exact OKVED post-apply verification failed');
    }

    await session.commit();
    began = false;
    return {
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
