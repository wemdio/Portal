import {
  assertPortalProductionTarget,
  assertSha256Hex,
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';
import type {
  FnsExactApplyCheckpoint,
  FnsExactApplyCheckpointStore,
  FnsExactApplyTarget,
} from '@/lib/companiesDirectory/fnsExactCheckpoint';

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

export interface FnsExactCheckSession {
  stageArtifacts(): Promise<void>;
  beginReadOnly(): Promise<void>;
  preview(): Promise<FnsExactImportPreview>;
  rollback(): Promise<void>;
}

export interface FnsExactApplyPageResult {
  scannedRows: number;
  updatedRows: number;
  alreadyAppliedRows: number;
  cursorId: string;
}

export interface FnsExactApplySession extends FnsExactCheckSession {
  acquireSessionAdvisoryLock(): Promise<void>;
  releaseSessionAdvisoryLock(): Promise<void>;
  beginReadWrite(): Promise<void>;
  verifyAppliedPrefix(
    cursorId: string,
    expectedRows: number,
  ): Promise<void>;
  applyNextPage(
    afterCursorId: string | null,
    pageSize: number,
  ): Promise<FnsExactApplyPageResult>;
  commit(): Promise<void>;
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
  checkpointPath?: string;
  confirmedPlanFingerprint?: string;
  confirmedPreviewFingerprint?: string;
  confirmedTarget?: string;
  batchSize: number;
  resume: boolean;
}

export interface FnsExactResumableApplyOptions {
  planFingerprint: string;
  expectedPreviewFingerprint: string;
  target: FnsExactApplyTarget;
  pageSize: number;
  resume: boolean;
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
    batchSize: 25_000,
    resume: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      parsed.mode = 'apply';
    } else if (arg === '--check') {
      parsed.mode = 'check';
    } else if (arg === '--resume') {
      parsed.resume = true;
    } else if (arg === '--plan-dir') {
      parsed.planDir = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--manifest') {
      parsed.manifestPath = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--checkpoint') {
      parsed.checkpointPath = readFlagValue(args, index, arg);
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
  if (parsed.resume && parsed.mode !== 'apply') {
    throw new Error('--resume requires --apply');
  }
  return parsed;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid FNS preview ${label}: ${String(value)}`);
  }
}

export function assertFnsExactPreviewIsSafe(
  preview: FnsExactImportPreview,
): void {
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
  session: Pick<FnsExactCheckSession, 'rollback'>,
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

async function readSafePreview(
  session: FnsExactCheckSession,
): Promise<FnsExactImportPreview> {
  let began = false;
  try {
    await session.beginReadOnly();
    began = true;
    const preview = await session.preview();
    assertFnsExactPreviewIsSafe(preview);
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

async function verifyCheckpointPrefix(
  session: FnsExactApplySession,
  checkpoint: FnsExactApplyCheckpoint,
): Promise<void> {
  if (checkpoint.cursorId === null) {
    if (checkpoint.committedRows !== 0) {
      throw new Error('FNS checkpoint prefix metadata is inconsistent');
    }
    return;
  }
  if (checkpoint.committedRows < 1) {
    throw new Error('FNS checkpoint prefix metadata is inconsistent');
  }

  let began = false;
  try {
    await session.beginReadOnly();
    began = true;
    await session.verifyAppliedPrefix(
      checkpoint.cursorId,
      checkpoint.committedRows,
    );
    await session.rollback();
    began = false;
  } catch (error) {
    if (began) return rollbackAfterFailure(session, error);
    throw error;
  }
}

export async function executeFnsExactCheck(
  session: FnsExactCheckSession,
): Promise<FnsExactImportPreview> {
  await session.stageArtifacts();
  return readSafePreview(session);
}

function assertCheckpointMatches(
  checkpoint: FnsExactApplyCheckpoint,
  options: FnsExactResumableApplyOptions,
): void {
  if (checkpoint.version !== 1) {
    throw new Error('FNS checkpoint version does not match');
  }
  if (
    checkpoint.planFingerprint?.toLowerCase()
    !== options.planFingerprint.toLowerCase()
  ) {
    throw new Error('FNS checkpoint plan fingerprint does not match');
  }
  if (
    checkpoint.expectedPreviewFingerprint?.toLowerCase()
    !== options.expectedPreviewFingerprint.toLowerCase()
  ) {
    throw new Error('FNS checkpoint preview fingerprint does not match');
  }
  if (
    checkpoint.target?.host !== options.target.host
    || checkpoint.target?.port !== options.target.port
    || checkpoint.target?.database !== options.target.database
    || checkpoint.target?.table !== options.target.table
  ) {
    throw new Error('FNS checkpoint target does not match');
  }
  if (checkpoint.pageSize !== options.pageSize) {
    throw new Error('FNS checkpoint page size does not match');
  }
  if (
    checkpoint.cursorId !== null
    && !/^\d+$/.test(checkpoint.cursorId)
  ) {
    throw new Error('FNS checkpoint cursor is invalid');
  }
  if (
    !Number.isSafeInteger(checkpoint.committedRows)
    || checkpoint.committedRows < 0
  ) {
    throw new Error('FNS checkpoint committed row count is invalid');
  }
}

function validatePageResult(input: {
  page: FnsExactApplyPageResult;
  pageSize: number;
  previousCursor: string | null;
  remainingRows: number;
}): void {
  const { page } = input;
  for (const field of [
    'scannedRows',
    'updatedRows',
    'alreadyAppliedRows',
  ] as const) {
    assertNonNegativeInteger(page[field], `page ${field}`);
  }
  if (
    page.scannedRows < 1
    || page.scannedRows > input.pageSize
    || page.scannedRows > input.remainingRows
  ) {
    throw new Error(
      `Invalid FNS page scanned row count: ${page.scannedRows}`,
    );
  }
  if (
    page.updatedRows + page.alreadyAppliedRows !== page.scannedRows
  ) {
    throw new Error('FNS page classification is inconsistent');
  }
  if (!/^\d+$/.test(page.cursorId)) {
    throw new Error(`Invalid FNS page cursor: ${page.cursorId}`);
  }
  if (
    input.previousCursor !== null
    && BigInt(page.cursorId) <= BigInt(input.previousCursor)
  ) {
    throw new Error('FNS page cursor did not advance');
  }
}

function checkpointAfterPage(input: {
  options: FnsExactResumableApplyOptions;
  cursorId: string;
  committedRows: number;
}): FnsExactApplyCheckpoint {
  return {
    version: 1,
    planFingerprint: input.options.planFingerprint.toLowerCase(),
    expectedPreviewFingerprint:
      input.options.expectedPreviewFingerprint.toLowerCase(),
    target: { ...input.options.target },
    pageSize: input.options.pageSize,
    cursorId: input.cursorId,
    committedRows: input.committedRows,
  };
}

function assertFinalVerification(
  before: FnsExactImportPreview,
  after: FnsExactImportPreview,
): void {
  if (
    after.stagedUpdates !== before.stagedUpdates
    || after.rowsToUpdate !== 0
    || after.alreadyApplied !== after.stagedUpdates
  ) {
    throw new Error(
      'FNS exact OKVED final global verification has remaining rows',
    );
  }
}

export async function executeFnsExactResumableApply(
  session: FnsExactApplySession,
  checkpointStore: FnsExactApplyCheckpointStore,
  options: FnsExactResumableApplyOptions,
): Promise<FnsExactApplyResult> {
  assertSha256Hex(options.planFingerprint, 'FNS plan fingerprint');
  assertSha256Hex(
    options.expectedPreviewFingerprint,
    'FNS expected preview fingerprint',
  );
  if (
    !Number.isSafeInteger(options.pageSize)
    || options.pageSize < 1
    || options.pageSize > 100_000
  ) {
    throw new Error('FNS apply page size must be between 1 and 100000');
  }

  const storedCheckpoint = await checkpointStore.load();
  if (storedCheckpoint && !options.resume) {
    throw new Error(
      'A partial FNS import checkpoint exists; pass --resume explicitly',
    );
  }
  if (storedCheckpoint) {
    assertCheckpointMatches(storedCheckpoint, options);
  }

  let lockAcquired = false;
  let runError: unknown;
  try {
    await session.acquireSessionAdvisoryLock();
    lockAcquired = true;

    await session.stageArtifacts();
    const before = await readSafePreview(session);
    const wasAlreadyApplied = (
      before.rowsToUpdate === 0
      && before.alreadyApplied === before.stagedUpdates
    );
    if (storedCheckpoint) {
      await verifyCheckpointPrefix(session, storedCheckpoint);
    }
    if (
      !wasAlreadyApplied
      && !options.resume
      && before.fingerprint
        !== options.expectedPreviewFingerprint.toLowerCase()
    ) {
      throw new Error(
        'Live preview fingerprint changed; run --check again before applying',
      );
    }
    if (wasAlreadyApplied) {
      const after = await readSafePreview(session);
      assertFinalVerification(before, after);
      await checkpointStore.clear();
      return {
        updated: 0,
        alreadyApplied: true,
        before,
        after,
      };
    }

    let cursorId: string | null = null;
    let committedRows = 0;
    let updated = 0;
    while (committedRows < before.stagedUpdates) {
      let began = false;
      let page: FnsExactApplyPageResult;
      try {
        await session.beginReadWrite();
        began = true;
        page = await session.applyNextPage(cursorId, options.pageSize);
        validatePageResult({
          page,
          pageSize: options.pageSize,
          previousCursor: cursorId,
          remainingRows: before.stagedUpdates - committedRows,
        });
        await session.commit();
        began = false;
      } catch (error) {
        if (began) {
          return rollbackAfterFailure(session, error);
        }
        throw error;
      }

      cursorId = page.cursorId;
      committedRows += page.scannedRows;
      updated += page.updatedRows;
      await checkpointStore.save(checkpointAfterPage({
        options,
        cursorId,
        committedRows,
      }));
    }

    const after = await readSafePreview(session);
    assertFinalVerification(before, after);
    await checkpointStore.clear();
    return {
      updated,
      alreadyApplied: wasAlreadyApplied,
      before,
      after,
    };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await session.releaseSessionAdvisoryLock();
      } catch (releaseError) {
        if (runError !== undefined) {
          throw new AggregateError(
            [runError, releaseError],
            'FNS exact OKVED import failed and advisory unlock also failed',
          );
        }
        throw releaseError;
      }
    }
  }
}
