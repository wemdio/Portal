/** @jest-environment node */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  FileFnsExactApplyCheckpointStore,
  type FnsExactApplyCheckpoint,
} from '@/lib/companiesDirectory/fnsExactCheckpoint';

const CHECKPOINT: FnsExactApplyCheckpoint = {
  version: 1,
  planFingerprint: 'plan-fingerprint',
  expectedPreviewFingerprint: 'preview-fingerprint',
  target: {
    host: '139.60.162.12',
    port: 35434,
    database: 'postgres',
    table: 'companies_directory',
  },
  pageSize: 25_000,
  cursorId: '25000',
  committedRows: 25_000,
};

class RenameFailingCheckpointStore extends FileFnsExactApplyCheckpointStore {
  protected override async renameTempFile(
    _tempPath: string,
    _checkpointPath: string,
  ): Promise<void> {
    throw new Error('simulated rename failure');
  }
}

describe('FileFnsExactApplyCheckpointStore', () => {
  let tempRoot: string;
  let checkpointPath: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'fns-exact-checkpoint-'));
    checkpointPath = join(tempRoot, 'nested', 'apply-checkpoint.json');
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('round-trips a checkpoint and creates a missing parent directory', async () => {
    const store = new FileFnsExactApplyCheckpointStore(checkpointPath);

    expect(await store.load()).toBeNull();

    await store.save(CHECKPOINT);

    expect(await store.load()).toEqual(CHECKPOINT);
  });

  it('atomically overwrites an existing checkpoint', async () => {
    const store = new FileFnsExactApplyCheckpointStore(checkpointPath);
    const nextCheckpoint: FnsExactApplyCheckpoint = {
      ...CHECKPOINT,
      cursorId: '50000',
      committedRows: 50_000,
    };

    await store.save(CHECKPOINT);
    await store.save(nextCheckpoint);

    expect(await store.load()).toEqual(nextCheckpoint);
    expect(await readdir(dirname(checkpointPath))).toEqual([
      'apply-checkpoint.json',
    ]);
  });

  it('keeps the prior checkpoint and cleans its temp file when rename fails', async () => {
    const initialStore = new FileFnsExactApplyCheckpointStore(checkpointPath);
    const failingStore = new RenameFailingCheckpointStore(checkpointPath);
    const nextCheckpoint: FnsExactApplyCheckpoint = {
      ...CHECKPOINT,
      cursorId: '50000',
      committedRows: 50_000,
    };

    await initialStore.save(CHECKPOINT);

    await expect(failingStore.save(nextCheckpoint)).rejects.toThrow(
      'simulated rename failure',
    );

    expect(await initialStore.load()).toEqual(CHECKPOINT);
    expect(await readdir(dirname(checkpointPath))).toEqual([
      'apply-checkpoint.json',
    ]);
  });

  it('rejects corrupt JSON with the checkpoint path in the error', async () => {
    await new FileFnsExactApplyCheckpointStore(checkpointPath).save(CHECKPOINT);
    await writeFile(checkpointPath, '{"version":', 'utf8');

    await expect(
      new FileFnsExactApplyCheckpointStore(checkpointPath).load(),
    ).rejects.toThrow(
      `Invalid FNS exact apply checkpoint at "${checkpointPath}"`,
    );
  });

  it('rejects a parsed JSON value that does not match the checkpoint schema', async () => {
    await new FileFnsExactApplyCheckpointStore(checkpointPath).save(CHECKPOINT);
    await writeFile(
      checkpointPath,
      JSON.stringify({ ...CHECKPOINT, committedRows: -1 }),
      'utf8',
    );

    await expect(
      new FileFnsExactApplyCheckpointStore(checkpointPath).load(),
    ).rejects.toThrow('committedRows must be a non-negative integer');
  });

  it('clears an existing checkpoint and is idempotent when it is absent', async () => {
    const store = new FileFnsExactApplyCheckpointStore(checkpointPath);

    await store.save(CHECKPOINT);
    await store.clear();
    await store.clear();

    expect(await store.load()).toBeNull();
  });
});
