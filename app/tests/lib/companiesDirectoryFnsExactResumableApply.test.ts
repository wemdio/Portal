/** @jest-environment node */

import * as fnsExactApplyModule from '@/lib/companiesDirectory/fnsExactApply';
import {
  computeFnsExactPreviewFingerprint,
  parseFnsExactApplyCliArgs,
  type FnsExactImportPreview,
  type FnsExactImportPreviewBody,
} from '@/lib/companiesDirectory/fnsExactApply';

interface FnsExactApplyTarget {
  host: string;
  port: number;
  database: string;
  table: string;
}

interface FnsExactApplyCheckpoint {
  version: 1;
  planFingerprint: string;
  expectedPreviewFingerprint: string;
  target: FnsExactApplyTarget;
  pageSize: number;
  cursorId: string | null;
  committedRows: number;
}

interface FnsExactApplyCheckpointStore {
  load(): Promise<FnsExactApplyCheckpoint | null>;
  save(checkpoint: FnsExactApplyCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

interface FnsExactApplyPageResult {
  scannedRows: number;
  updatedRows: number;
  alreadyAppliedRows: number;
  cursorId: string;
}

interface FnsExactResumableApplySession {
  acquireSessionAdvisoryLock(): Promise<void>;
  releaseSessionAdvisoryLock(): Promise<void>;
  stageArtifacts(): Promise<void>;
  beginReadOnly(): Promise<void>;
  beginReadWrite(): Promise<void>;
  preview(): Promise<FnsExactImportPreview>;
  verifyAppliedPrefix(
    cursorId: string,
    expectedRows: number,
  ): Promise<void>;
  applyNextPage(
    afterCursorId: string | null,
    pageSize: number,
  ): Promise<FnsExactApplyPageResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface FnsExactResumableApplyOptions {
  planFingerprint: string;
  expectedPreviewFingerprint: string;
  target: FnsExactApplyTarget;
  pageSize: number;
  resume: boolean;
}

interface FnsExactResumableApplyResult {
  updated: number;
  alreadyApplied: boolean;
  before: FnsExactImportPreview;
  after: FnsExactImportPreview;
}

type ExecuteFnsExactResumableApply = (
  session: FnsExactResumableApplySession,
  checkpointStore: FnsExactApplyCheckpointStore,
  options: FnsExactResumableApplyOptions,
) => Promise<FnsExactResumableApplyResult>;

const executeFnsExactResumableApply = (
  fnsExactApplyModule as unknown as {
    executeFnsExactResumableApply: ExecuteFnsExactResumableApply;
  }
).executeFnsExactResumableApply;

const PLAN_FINGERPRINT = '1'.repeat(64);
const PAGE_SIZE = 25_000;
const TARGET: FnsExactApplyTarget = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'public.companies_directory',
};

function makePreview(
  overrides: Partial<FnsExactImportPreviewBody> = {},
): FnsExactImportPreview {
  const body: FnsExactImportPreviewBody = {
    stagedUpdates: 50_001,
    rowsToUpdate: 50_001,
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

function makeOptions(
  expectedPreviewFingerprint: string,
  overrides: Partial<FnsExactResumableApplyOptions> = {},
): FnsExactResumableApplyOptions {
  return {
    planFingerprint: PLAN_FINGERPRINT,
    expectedPreviewFingerprint,
    target: TARGET,
    pageSize: PAGE_SIZE,
    resume: false,
    ...overrides,
  };
}

function makeCheckpoint(
  expectedPreviewFingerprint: string,
  overrides: Partial<FnsExactApplyCheckpoint> = {},
): FnsExactApplyCheckpoint {
  return {
    version: 1,
    planFingerprint: PLAN_FINGERPRINT,
    expectedPreviewFingerprint,
    target: TARGET,
    pageSize: PAGE_SIZE,
    cursorId: '25000',
    committedRows: 25_000,
    ...overrides,
  };
}

function makeCheckpointStore(
  initial: FnsExactApplyCheckpoint | null,
  events: string[] = [],
): jest.Mocked<FnsExactApplyCheckpointStore> & {
  current(): FnsExactApplyCheckpoint | null;
} {
  let checkpoint = initial;
  let saveNumber = 0;
  return {
    load: jest.fn(async () => checkpoint),
    save: jest.fn(async (next) => {
      saveNumber += 1;
      events.push(`checkpoint:${saveNumber}:${next.cursorId}`);
      checkpoint = structuredClone(next);
    }),
    clear: jest.fn(async () => {
      events.push('checkpoint:clear');
      checkpoint = null;
    }),
    current: () => checkpoint,
  };
}

function makeSession(input: {
  previews: FnsExactImportPreview[];
  pages: Array<FnsExactApplyPageResult | Error>;
  prefixError?: Error;
  events?: string[];
}): jest.Mocked<FnsExactResumableApplySession> {
  const events = input.events ?? [];
  let previewNumber = 0;
  let transactionNumber = 0;
  let commitNumber = 0;
  let rollbackNumber = 0;

  return {
    acquireSessionAdvisoryLock: jest.fn(async () => {
      events.push('lock:acquire');
    }),
    releaseSessionAdvisoryLock: jest.fn(async () => {
      events.push('lock:release');
    }),
    stageArtifacts: jest.fn(async () => {
      events.push('stage');
    }),
    beginReadOnly: jest.fn(async () => {
      transactionNumber += 1;
      events.push(`begin:read-only:${transactionNumber}`);
    }),
    beginReadWrite: jest.fn(async () => {
      transactionNumber += 1;
      events.push(`begin:read-write:${transactionNumber}`);
    }),
    preview: jest.fn(async () => {
      previewNumber += 1;
      events.push(`preview:${previewNumber}`);
      const next = input.previews.shift();
      if (!next) throw new Error('No preview configured');
      return next;
    }),
    verifyAppliedPrefix: jest.fn(async (cursorId, expectedRows) => {
      events.push(`prefix:${cursorId}:${expectedRows}`);
      if (input.prefixError) throw input.prefixError;
    }),
    applyNextPage: jest.fn(async (afterCursorId, pageSize) => {
      events.push(`page:${afterCursorId ?? 'start'}:${pageSize}`);
      const next = input.pages.shift();
      if (!next) throw new Error('No page configured');
      if (next instanceof Error) throw next;
      return next;
    }),
    commit: jest.fn(async () => {
      commitNumber += 1;
      events.push(`commit:${commitNumber}`);
    }),
    rollback: jest.fn(async () => {
      rollbackNumber += 1;
      events.push(`rollback:${rollbackNumber}`);
    }),
  };
}

describe('FNS exact OKVED resumable apply orchestration', () => {
  it('defaults to 25k pages and requires an explicit --resume flag', () => {
    expect(parseFnsExactApplyCliArgs([
      '--plan-dir',
      'C:\\plan',
    ])).toMatchObject({
      batchSize: PAGE_SIZE,
      resume: false,
    });
    expect(parseFnsExactApplyCliArgs([
      '--apply',
      '--resume',
      '--plan-dir',
      'C:\\plan',
    ])).toMatchObject({
      mode: 'apply',
      batchSize: PAGE_SIZE,
      resume: true,
    });
  });

  it('commits every 25k page separately while one session lock spans the run', async () => {
    const events: string[] = [];
    const before = makePreview();
    const after = makePreview({
      rowsToUpdate: 0,
      alreadyApplied: 50_001,
      stateDigest: 'b'.repeat(64),
    });
    const session = makeSession({
      previews: [before, after],
      pages: [
        {
          scannedRows: 25_000,
          updatedRows: 25_000,
          alreadyAppliedRows: 0,
          cursorId: '25000',
        },
        {
          scannedRows: 25_000,
          updatedRows: 25_000,
          alreadyAppliedRows: 0,
          cursorId: '50000',
        },
        {
          scannedRows: 1,
          updatedRows: 1,
          alreadyAppliedRows: 0,
          cursorId: '90071992547409930',
        },
      ],
      events,
    });
    const checkpointStore = makeCheckpointStore(null, events);

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(before.fingerprint),
    )).resolves.toEqual({
      updated: 50_001,
      alreadyApplied: false,
      before,
      after,
    });

    expect(session.acquireSessionAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(session.releaseSessionAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(session.stageArtifacts).toHaveBeenCalledTimes(1);
    expect(session.beginReadWrite).toHaveBeenCalledTimes(3);
    expect(session.commit).toHaveBeenCalledTimes(3);
    expect(session.beginReadOnly).toHaveBeenCalledTimes(2);
    expect(session.rollback).toHaveBeenCalledTimes(2);
    expect(session.applyNextPage.mock.calls).toEqual([
      [null, PAGE_SIZE],
      ['25000', PAGE_SIZE],
      ['50000', PAGE_SIZE],
    ]);
    expect(checkpointStore.save.mock.calls.map(([checkpoint]) => ({
      version: checkpoint.version,
      cursorId: checkpoint.cursorId,
      committedRows: checkpoint.committedRows,
      target: checkpoint.target,
      pageSize: checkpoint.pageSize,
    }))).toEqual([
      {
        version: 1,
        cursorId: '25000',
        committedRows: 25_000,
        target: TARGET,
        pageSize: PAGE_SIZE,
      },
      {
        version: 1,
        cursorId: '50000',
        committedRows: 50_000,
        target: TARGET,
        pageSize: PAGE_SIZE,
      },
      {
        version: 1,
        cursorId: '90071992547409930',
        committedRows: 50_001,
        target: TARGET,
        pageSize: PAGE_SIZE,
      },
    ]);
    expect(checkpointStore.clear).toHaveBeenCalledTimes(1);

    expect(events[0]).toBe('lock:acquire');
    expect(events.at(-1)).toBe('lock:release');
    expect(events.indexOf('commit:1')).toBeLessThan(
      events.indexOf('checkpoint:1:25000'),
    );
    expect(events.indexOf('checkpoint:1:25000')).toBeLessThan(
      events.indexOf('begin:read-write:3'),
    );
    expect(events.indexOf('preview:2')).toBeLessThan(
      events.indexOf('checkpoint:clear'),
    );
    expect(events.indexOf('checkpoint:clear')).toBeLessThan(
      events.indexOf('lock:release'),
    );
  });

  it('keeps prior commits and does not advance checkpoint when page N fails', async () => {
    const events: string[] = [];
    const before = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 50_000,
    });
    const session = makeSession({
      previews: [before],
      pages: [
        {
          scannedRows: 25_000,
          updatedRows: 25_000,
          alreadyAppliedRows: 0,
          cursorId: '25000',
        },
        new Error('page 2 update failed'),
      ],
      events,
    });
    const checkpointStore = makeCheckpointStore(null, events);

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(before.fingerprint),
    )).rejects.toThrow('page 2 update failed');

    expect(session.commit).toHaveBeenCalledTimes(1);
    expect(session.rollback).toHaveBeenCalledTimes(2);
    expect(checkpointStore.save).toHaveBeenCalledTimes(1);
    expect(checkpointStore.current()).toEqual(makeCheckpoint(
      before.fingerprint,
    ));
    expect(checkpointStore.clear).not.toHaveBeenCalled();
    expect(session.releaseSessionAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(events.indexOf('commit:1')).toBeLessThan(
      events.indexOf('checkpoint:1:25000'),
    );
    expect(events.at(-1)).toBe('lock:release');
  });

  it('re-walks a committed page as a no-op after commit succeeds but checkpoint save crashes', async () => {
    const firstBefore = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 50_000,
    });
    const firstSession = makeSession({
      previews: [firstBefore],
      pages: [{
        scannedRows: 25_000,
        updatedRows: 25_000,
        alreadyAppliedRows: 0,
        cursorId: '25000',
      }],
    });
    const checkpointStore = makeCheckpointStore(null);
    checkpointStore.save.mockRejectedValueOnce(
      new Error('checkpoint disk write crashed'),
    );

    await expect(executeFnsExactResumableApply(
      firstSession,
      checkpointStore,
      makeOptions(firstBefore.fingerprint),
    )).rejects.toThrow('checkpoint disk write crashed');

    expect(firstSession.commit).toHaveBeenCalledTimes(1);
    expect(checkpointStore.current()).toBeNull();
    expect(firstSession.releaseSessionAdvisoryLock).toHaveBeenCalledTimes(1);

    const resumedBefore = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 25_000,
      alreadyApplied: 25_000,
      stateDigest: 'c'.repeat(64),
    });
    const resumedAfter = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 0,
      alreadyApplied: 50_000,
      stateDigest: 'd'.repeat(64),
    });
    const resumedSession = makeSession({
      previews: [resumedBefore, resumedAfter],
      pages: [
        {
          scannedRows: 25_000,
          updatedRows: 0,
          alreadyAppliedRows: 25_000,
          cursorId: '25000',
        },
        {
          scannedRows: 25_000,
          updatedRows: 25_000,
          alreadyAppliedRows: 0,
          cursorId: '50000',
        },
      ],
    });

    await expect(executeFnsExactResumableApply(
      resumedSession,
      checkpointStore,
      makeOptions(firstBefore.fingerprint, { resume: true }),
    )).resolves.toMatchObject({
      updated: 25_000,
      alreadyApplied: false,
      before: resumedBefore,
      after: resumedAfter,
    });

    expect(resumedSession.applyNextPage.mock.calls).toEqual([
      [null, PAGE_SIZE],
      ['25000', PAGE_SIZE],
    ]);
    expect(checkpointStore.save).toHaveBeenLastCalledWith(makeCheckpoint(
      firstBefore.fingerprint,
      {
        cursorId: '50000',
        committedRows: 50_000,
      },
    ));
    expect(checkpointStore.clear).toHaveBeenCalledTimes(1);
  });

  it('requires --resume and never trusts a stored cursor as the starting point', async () => {
    const original = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 50_000,
    });
    const checkpoint = makeCheckpoint(original.fingerprint);
    const checkpointStore = makeCheckpointStore(checkpoint);
    const blockedSession = makeSession({
      previews: [],
      pages: [],
    });

    await expect(executeFnsExactResumableApply(
      blockedSession,
      checkpointStore,
      makeOptions(original.fingerprint),
    )).rejects.toThrow(/--resume/i);
    expect(blockedSession.acquireSessionAdvisoryLock).not.toHaveBeenCalled();

    const resumedBefore = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 25_000,
      alreadyApplied: 25_000,
      stateDigest: 'e'.repeat(64),
    });
    const resumedAfter = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 0,
      alreadyApplied: 50_000,
      stateDigest: 'f'.repeat(64),
    });
    const resumedSession = makeSession({
      previews: [resumedBefore, resumedAfter],
      pages: [
        {
          scannedRows: 25_000,
          updatedRows: 0,
          alreadyAppliedRows: 25_000,
          cursorId: '25000',
        },
        {
          scannedRows: 25_000,
          updatedRows: 25_000,
          alreadyAppliedRows: 0,
          cursorId: '50000',
        },
      ],
    });

    await executeFnsExactResumableApply(
      resumedSession,
      checkpointStore,
      makeOptions(original.fingerprint, { resume: true }),
    );

    expect(resumedSession.applyNextPage).toHaveBeenNthCalledWith(
      1,
      null,
      PAGE_SIZE,
    );
  });

  it.each([
    ['version', { version: 2 as 1 }],
    ['plan fingerprint', { planFingerprint: '2'.repeat(64) }],
    ['preview fingerprint', {
      expectedPreviewFingerprint: '2'.repeat(64),
    }],
    ['target', {
      target: { ...TARGET, host: '144.31.54.166' },
    }],
    ['page size', { pageSize: 20_000 }],
  ])('blocks resume when checkpoint %s does not match', async (
    label,
    checkpointOverrides,
  ) => {
    const original = makePreview();
    const checkpointStore = makeCheckpointStore(makeCheckpoint(
      original.fingerprint,
      checkpointOverrides,
    ));
    const session = makeSession({
      previews: [],
      pages: [],
    });

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(original.fingerprint, { resume: true }),
    )).rejects.toThrow(new RegExp(label, 'i'));
    expect(session.acquireSessionAdvisoryLock).not.toHaveBeenCalled();
    expect(session.applyNextPage).not.toHaveBeenCalled();
  });

  it('keeps the last checkpoint and fails if the final global verification is incomplete', async () => {
    const before = makePreview({
      stagedUpdates: 25_000,
      rowsToUpdate: 25_000,
    });
    const incompleteAfter = makePreview({
      stagedUpdates: 25_000,
      rowsToUpdate: 1,
      alreadyApplied: 24_999,
      stateDigest: '9'.repeat(64),
    });
    const session = makeSession({
      previews: [before, incompleteAfter],
      pages: [{
        scannedRows: 25_000,
        updatedRows: 25_000,
        alreadyAppliedRows: 0,
        cursorId: '25000',
      }],
    });
    const checkpointStore = makeCheckpointStore(null);

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(before.fingerprint),
    )).rejects.toThrow(/final|global|verification|remaining/i);

    expect(session.preview).toHaveBeenCalledTimes(2);
    expect(session.beginReadOnly).toHaveBeenCalledTimes(2);
    expect(session.commit).toHaveBeenCalledTimes(1);
    expect(checkpointStore.current()).toEqual(makeCheckpoint(
      before.fingerprint,
    ));
    expect(checkpointStore.clear).not.toHaveBeenCalled();
    expect(session.releaseSessionAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it('blocks resume when the committed checkpoint prefix is no longer exact', async () => {
    const original = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 50_000,
    });
    const current = makePreview({
      stagedUpdates: 50_000,
      rowsToUpdate: 25_001,
      alreadyApplied: 24_999,
      stateDigest: '8'.repeat(64),
    });
    const checkpointStore = makeCheckpointStore(makeCheckpoint(
      original.fingerprint,
    ));
    const session = makeSession({
      previews: [current],
      pages: [],
      prefixError: new Error(
        'FNS checkpoint prefix is not fully applied',
      ),
    });

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(original.fingerprint, { resume: true }),
    )).rejects.toThrow(/checkpoint prefix.*not fully applied/i);

    expect(session.verifyAppliedPrefix).toHaveBeenCalledWith(
      '25000',
      25_000,
    );
    expect(session.beginReadWrite).not.toHaveBeenCalled();
    expect(checkpointStore.save).not.toHaveBeenCalled();
    expect(checkpointStore.current()).toEqual(makeCheckpoint(
      original.fingerprint,
    ));
    expect(session.releaseSessionAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it('treats a fully applied repeat as a verified no-op', async () => {
    const before = makePreview({
      stagedUpdates: 100_005,
      rowsToUpdate: 0,
      alreadyApplied: 100_005,
      stateDigest: '7'.repeat(64),
    });
    const after = makePreview({
      stagedUpdates: 100_005,
      rowsToUpdate: 0,
      alreadyApplied: 100_005,
      stateDigest: '6'.repeat(64),
    });
    const session = makeSession({
      previews: [before, after],
      pages: [],
    });
    const checkpointStore = makeCheckpointStore(null);

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(before.fingerprint),
    )).resolves.toEqual({
      updated: 0,
      alreadyApplied: true,
      before,
      after,
    });

    expect(session.applyNextPage).not.toHaveBeenCalled();
    expect(session.beginReadWrite).not.toHaveBeenCalled();
    expect(checkpointStore.save).not.toHaveBeenCalled();
    expect(checkpointStore.clear).toHaveBeenCalledTimes(1);
  });

  it('walks 100005 rows with bigint gaps and a partial final page', async () => {
    const before = makePreview({
      stagedUpdates: 100_005,
      rowsToUpdate: 100_005,
    });
    const after = makePreview({
      stagedUpdates: 100_005,
      rowsToUpdate: 0,
      alreadyApplied: 100_005,
      stateDigest: '5'.repeat(64),
    });
    const cursors = [
      '25000',
      '9007199254740993',
      '9007199254777777',
      '9007199254999999',
      '9223372036854775807',
    ];
    const session = makeSession({
      previews: [before, after],
      pages: cursors.map((cursorId, index) => ({
        scannedRows: index === cursors.length - 1 ? 5 : 25_000,
        updatedRows: index === cursors.length - 1 ? 5 : 25_000,
        alreadyAppliedRows: 0,
        cursorId,
      })),
    });
    const checkpointStore = makeCheckpointStore(null);

    await expect(executeFnsExactResumableApply(
      session,
      checkpointStore,
      makeOptions(before.fingerprint),
    )).resolves.toMatchObject({
      updated: 100_005,
      alreadyApplied: false,
    });

    expect(session.applyNextPage).toHaveBeenCalledTimes(5);
    expect(session.applyNextPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      null,
      ...cursors.slice(0, -1),
    ]);
    expect(checkpointStore.save).toHaveBeenLastCalledWith(makeCheckpoint(
      before.fingerprint,
      {
        cursorId: cursors.at(-1),
        committedRows: 100_005,
      },
    ));
  });
});
