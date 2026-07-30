/** @jest-environment node */

import {
  assertFnsExactApplyAuthorized,
  assertFnsProductionTarget,
  computeFnsExactPreviewFingerprint,
  executeFnsExactApply,
  executeFnsExactCheck,
  parseFnsExactApplyCliArgs,
  type FnsExactApplySession,
  type FnsExactImportPreview,
  type FnsExactImportPreviewBody,
} from '@/lib/companiesDirectory/fnsExactApply';

function makePreview(
  overrides: Partial<FnsExactImportPreviewBody> = {},
): FnsExactImportPreview {
  const body: FnsExactImportPreviewBody = {
    stagedUpdates: 3,
    rowsToUpdate: 3,
    alreadyApplied: 0,
    missingTargets: 0,
    identityMismatches: 0,
    conflictingValues: 0,
    stateDigest: 'a'.repeat(64),
    ...overrides,
  };
  return {
    ...body,
    fingerprint: computeFnsExactPreviewFingerprint(body),
  };
}

function makeSession(
  previews: FnsExactImportPreview[],
): jest.Mocked<FnsExactApplySession> {
  return {
    beginReadOnly: jest.fn().mockResolvedValue(undefined),
    beginReadWrite: jest.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    stageArtifacts: jest.fn().mockResolvedValue(undefined),
    preview: jest.fn().mockImplementation(async () => {
      const next = previews.shift();
      if (!next) throw new Error('No preview configured');
      return next;
    }),
    updateNextBatch: jest.fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
}

describe('FNS exact OKVED apply guardrails', () => {
  it('defaults CLI to check and requires explicit apply confirmations', () => {
    expect(parseFnsExactApplyCliArgs([
      '--plan-dir',
      'C:\\plan',
    ])).toMatchObject({
      mode: 'check',
      planDir: 'C:\\plan',
      batchSize: 20_000,
    });
    expect(parseFnsExactApplyCliArgs([
      '--apply',
      '--plan-dir',
      'C:\\plan',
      '--manifest',
      'C:\\plan\\manifest.json',
      '--confirm-plan',
      '1'.repeat(64),
      '--confirm-preview',
      '2'.repeat(64),
      '--confirm-target',
      '139.60.162.12',
      '--batch-size',
      '5000',
    ])).toMatchObject({
      mode: 'apply',
      batchSize: 5_000,
      confirmedTarget: '139.60.162.12',
    });
    expect(() => parseFnsExactApplyCliArgs([])).toThrow('--plan-dir');
    expect(() => parseFnsExactApplyCliArgs([
      '--plan-dir',
      'C:\\plan',
      '--unknown',
      'x',
    ])).toThrow('Unknown');
  });

  it('checks in a read-only transaction and never calls target DML', async () => {
    const before = makePreview();
    const session = makeSession([before]);

    await expect(executeFnsExactCheck(session)).resolves.toEqual(before);

    expect(session.beginReadOnly).toHaveBeenCalledTimes(1);
    expect(session.stageArtifacts).toHaveBeenCalledTimes(1);
    expect(session.updateNextBatch).not.toHaveBeenCalled();
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).toHaveBeenCalledTimes(1);
    expect(session).not.toHaveProperty('insertMissing');
  });

  it('requires exact plan and live-preview fingerprints for apply', () => {
    const planFingerprint = '1'.repeat(64);
    const previewFingerprint = '2'.repeat(64);

    expect(() => assertFnsExactApplyAuthorized({
      mode: 'check',
      planFingerprint,
      confirmedPlanFingerprint: planFingerprint,
      previewFingerprint,
      confirmedPreviewFingerprint: previewFingerprint,
    })).toThrow('--apply');
    expect(() => assertFnsExactApplyAuthorized({
      mode: 'apply',
      planFingerprint,
      confirmedPlanFingerprint: '3'.repeat(64),
      previewFingerprint,
      confirmedPreviewFingerprint: previewFingerprint,
    })).toThrow('plan fingerprint');
    expect(() => assertFnsExactApplyAuthorized({
      mode: 'apply',
      planFingerprint,
      confirmedPlanFingerprint: planFingerprint,
      previewFingerprint,
      confirmedPreviewFingerprint: '3'.repeat(64),
    })).toThrow('preview fingerprint');
    expect(() => assertFnsExactApplyAuthorized({
      mode: 'apply',
      planFingerprint,
      confirmedPlanFingerprint: planFingerprint,
      previewFingerprint,
      confirmedPreviewFingerprint: previewFingerprint,
    })).not.toThrow();
  });

  it('accepts only the explicitly confirmed current Portal database target', () => {
    expect(assertFnsProductionTarget(
      'postgresql://139.60.162.12:35434/postgres',
      '139.60.162.12',
    )).toEqual({
      host: '139.60.162.12',
      port: 35434,
      database: 'postgres',
    });
    expect(() => assertFnsProductionTarget(
      'postgresql://144.31.54.166:35434/postgres',
      '139.60.162.12',
    )).toThrow('former');
    expect(() => assertFnsProductionTarget(
      'postgresql://139.60.162.12:35434/postgres?host=144.31.54.166',
      '139.60.162.12',
    )).toThrow('query parameter');
    expect(() => assertFnsProductionTarget(
      'postgresql://139.60.162.12:35434/postgres',
      undefined,
    )).toThrow('explicitly confirmed');
  });

  it.each([
    ['missing target', { missingTargets: 1 }],
    ['identity mismatch', { identityMismatches: 1 }],
    ['conflicting exact value', { conflictingValues: 1 }],
  ])('blocks %s before target DML and rolls back', async (_label, unsafe) => {
    const before = makePreview({
      ...unsafe,
      stateDigest: 'b'.repeat(64),
    });
    const session = makeSession([before]);

    await expect(
      executeFnsExactApply(session, before.fingerprint, 2),
    ).rejects.toThrow(/missing|identity|conflict/i);

    expect(session.updateNextBatch).not.toHaveBeenCalled();
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).toHaveBeenCalledTimes(1);
  });

  it('is one atomic transaction across batches and verifies the post-state', async () => {
    const before = makePreview();
    const after = makePreview({
      rowsToUpdate: 0,
      alreadyApplied: 3,
      stateDigest: 'c'.repeat(64),
    });
    const session = makeSession([before, after]);

    await expect(
      executeFnsExactApply(session, before.fingerprint, 2),
    ).resolves.toEqual({
      updated: 3,
      alreadyApplied: false,
      before,
      after,
    });

    expect(session.beginReadWrite).toHaveBeenCalledTimes(1);
    expect(session.acquireAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(session.updateNextBatch).toHaveBeenNthCalledWith(1, 2);
    expect(session.updateNextBatch).toHaveBeenNthCalledWith(2, 1);
    expect(session.commit).toHaveBeenCalledTimes(1);
    expect(session.rollback).not.toHaveBeenCalled();
  });

  it('treats a repeat as a no-op and rolls back any partial-count drift', async () => {
    const alreadyApplied = makePreview({
      rowsToUpdate: 0,
      alreadyApplied: 3,
      stateDigest: 'd'.repeat(64),
    });
    const repeated = makeSession([alreadyApplied]);

    await expect(
      executeFnsExactApply(repeated, '0'.repeat(64), 2),
    ).resolves.toMatchObject({
      updated: 0,
      alreadyApplied: true,
    });
    expect(repeated.updateNextBatch).not.toHaveBeenCalled();
    expect(repeated.commit).toHaveBeenCalledTimes(1);

    const before = makePreview();
    const drifted = makeSession([before]);
    drifted.updateNextBatch
      .mockReset()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    await expect(
      executeFnsExactApply(drifted, before.fingerprint, 2),
    ).rejects.toThrow('updated row count');
    expect(drifted.commit).not.toHaveBeenCalled();
    expect(drifted.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back when artifact validation fails during staging', async () => {
    const before = makePreview();
    const session = makeSession([before]);
    session.stageArtifacts.mockRejectedValueOnce(
      new Error('archive SHA-256 mismatch'),
    );

    await expect(
      executeFnsExactApply(session, before.fingerprint, 2),
    ).rejects.toThrow('archive SHA-256 mismatch');
    expect(session.updateNextBatch).not.toHaveBeenCalled();
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).toHaveBeenCalledTimes(1);
  });
});
