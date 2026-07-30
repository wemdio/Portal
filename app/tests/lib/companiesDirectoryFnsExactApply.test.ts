/** @jest-environment node */

import {
  assertFnsExactApplyAuthorized,
  assertFnsProductionTarget,
  computeFnsExactPreviewFingerprint,
  executeFnsExactCheck,
  parseFnsExactApplyCliArgs,
  type FnsExactCheckSession,
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
): jest.Mocked<FnsExactCheckSession> {
  return {
    stageArtifacts: jest.fn().mockResolvedValue(undefined),
    beginReadOnly: jest.fn().mockResolvedValue(undefined),
    preview: jest.fn().mockImplementation(async () => {
      const next = previews.shift();
      if (!next) throw new Error('No preview configured');
      return next;
    }),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
}

describe('FNS exact OKVED apply guardrails', () => {
  it('defaults CLI to check with 25k pages and requires explicit resume', () => {
    expect(parseFnsExactApplyCliArgs([
      '--plan-dir',
      'C:\\plan',
    ])).toMatchObject({
      mode: 'check',
      planDir: 'C:\\plan',
      batchSize: 25_000,
      resume: false,
    });
    expect(parseFnsExactApplyCliArgs([
      '--apply',
      '--resume',
      '--plan-dir',
      'C:\\plan',
      '--manifest',
      'C:\\plan\\manifest.json',
      '--checkpoint',
      'C:\\state\\fns.json',
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
      resume: true,
      checkpointPath: 'C:\\state\\fns.json',
      confirmedTarget: '139.60.162.12',
    });
    expect(() => parseFnsExactApplyCliArgs([])).toThrow('--plan-dir');
    expect(() => parseFnsExactApplyCliArgs([
      '--plan-dir',
      'C:\\plan',
      '--resume',
    ])).toThrow('--resume requires --apply');
    expect(() => parseFnsExactApplyCliArgs([
      '--plan-dir',
      'C:\\plan',
      '--unknown',
      'x',
    ])).toThrow('Unknown');
  });

  it('COPY-stages before a read-only check transaction and never calls DML', async () => {
    const before = makePreview();
    const session = makeSession([before]);

    await expect(executeFnsExactCheck(session)).resolves.toEqual(before);

    expect(session.stageArtifacts).toHaveBeenCalledTimes(1);
    expect(session.beginReadOnly).toHaveBeenCalledTimes(1);
    expect(session.stageArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      session.beginReadOnly.mock.invocationCallOrder[0],
    );
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

    await expect(executeFnsExactCheck(session)).rejects.toThrow(
      /missing|identity|conflict/i,
    );

    expect(session.rollback).toHaveBeenCalledTimes(1);
  });

  it('fails artifact validation before opening a database transaction', async () => {
    const session = makeSession([]);
    session.stageArtifacts.mockRejectedValueOnce(
      new Error('archive SHA-256 mismatch'),
    );

    await expect(executeFnsExactCheck(session)).rejects.toThrow(
      'archive SHA-256 mismatch',
    );
    expect(session.beginReadOnly).not.toHaveBeenCalled();
    expect(session.preview).not.toHaveBeenCalled();
    expect(session.rollback).not.toHaveBeenCalled();
  });
});
