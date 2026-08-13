/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import {
  mapAutoPipelineChunkUntilStopped,
  retainRowsSafeAfterInterruptedAppend,
  waitForAutoPipelineDelay,
} from '@/lib/jobs/autoPipelineChunk';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('auto-pipeline cooperative worker lifecycle', () => {
  it('stops scheduling new domains after shutdown and preserves completed results', async () => {
    let stopping = false;
    const processed: number[] = [];

    const outcome = await mapAutoPipelineChunkUntilStopped({
      items: [1, 2, 3, 4],
      concurrency: 1,
      shouldStop: () => stopping,
      process: async (item) => {
        processed.push(item);
        stopping = true;
        return item * 10;
      },
    });

    expect(processed).toEqual([1]);
    expect(outcome).toEqual({
      completed: [{ index: 0, value: 10 }],
      interrupted: true,
    });
  });

  it('does not start work when shutdown was already requested', async () => {
    const process = jest.fn(async (item: number) => item);

    await expect(mapAutoPipelineChunkUntilStopped({
      items: [1, 2],
      concurrency: 2,
      shouldStop: () => true,
      process,
    })).resolves.toEqual({ completed: [], interrupted: true });

    expect(process).not.toHaveBeenCalled();
  });

  it('preserves input order when concurrent items finish out of order', async () => {
    const outcome = await mapAutoPipelineChunkUntilStopped({
      items: ['slow', 'fast'],
      concurrency: 2,
      shouldStop: () => false,
      process: async (item) => {
        if (item === 'slow') {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        return item.toUpperCase();
      },
    });

    expect(outcome).toEqual({
      completed: [
        { index: 0, value: 'SLOW' },
        { index: 1, value: 'FAST' },
      ],
      interrupted: false,
    });
  });

  it('interrupts a nightly pacing delay after shutdown is requested', async () => {
    let stopping = false;
    const sleep = jest.fn(async () => {
      stopping = true;
    });

    await expect(waitForAutoPipelineDelay({
      delayMs: 60_000,
      pollIntervalMs: 1_000,
      shouldStop: () => stopping,
      sleep,
    })).resolves.toBe(true);

    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('finishes the in-flight campaign append and leaves later campaign rows resumable', async () => {
    let stopping = false;
    const appendCalls: string[] = [];

    const outcome = await mapAutoPipelineChunkUntilStopped({
      items: ['campaign-a', 'campaign-b', 'campaign-c'],
      concurrency: 1,
      shouldStop: () => stopping,
      process: async (campaign) => {
        appendCalls.push(campaign);
        stopping = true;
        return campaign;
      },
    });

    expect(appendCalls).toEqual(['campaign-a']);
    expect(outcome).toEqual({
      completed: [{ index: 0, value: 'campaign-a' }],
      interrupted: true,
    });

    const rows = [
      { employerId: 'a', status: 'routed' },
      { employerId: 'b', status: 'routed' },
      { employerId: 'c', status: 'skipped' },
    ];
    expect(retainRowsSafeAfterInterruptedAppend({
      rows,
      getEmployerId: (row) => row.employerId,
      appendCandidateEmployerIds: new Set(['a', 'b']),
      completedAppendEmployerIds: new Set(['a']),
    })).toEqual([
      { employerId: 'a', status: 'routed' },
      { employerId: 'c', status: 'skipped' },
    ]);
  });

  it('wires cooperative shutdown into enrichment and stale cleanup before scheduling', () => {
    const daemon = readRepoFile('app/worker/autoPipeline.ts');
    const runner = readRepoFile('app/src/lib/jobs/autoPipelineRunner.ts');

    expect(runner).toContain('mapAutoPipelineChunkUntilStopped');
    expect(runner).toMatch(/enrichEmployers\([\s\S]*?shouldStop/);
    expect(runner).toContain('retainRowsSafeAfterInterruptedAppend');
    expect(runner).toMatch(/cleanCompanyNames\([\s\S]*?opts\.shouldStop/);

    const persistCompletedPrefixIndex = runner.indexOf(
      'await upsertSeenEmployers(persistedSeenUpserts)',
    );
    const committedStopIndex = runner.indexOf(
      'if (appendWasInterrupted || opts.shouldStop?.())',
      persistCompletedPrefixIndex,
    );
    expect(persistCompletedPrefixIndex).toBeGreaterThanOrEqual(0);
    expect(committedStopIndex).toBeGreaterThan(persistCompletedPrefixIndex);

    const cleanupIndex = daemon.indexOf('closeStaleAutoPipelineRuns(client.clientUserId');
    const dueIndex = daemon.indexOf('decideDue(db, client');
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(dueIndex).toBeGreaterThan(cleanupIndex);
  });
});
