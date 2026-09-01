/**
 * @jest-environment node
 *
 * Regression contracts for Base Constructor worker ownership.
 *
 * A deploy can reclaim the same processing job while the old container still
 * has a few seconds to run.  Status-only guards cannot distinguish those two
 * workers: both see `processing`, so the old one can overwrite the new
 * owner's progress/checkpoint/final result (or mark it failed).  Every claim
 * therefore gets a fresh run token and every write from the runner must be
 * fenced by that token.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  runBaseConstructorJob,
  updateJobProgress,
} from '@/lib/tools/baseConstructorWorker';
import { stepValidateEmails } from '@/lib/tools/processingSteps';
import { uploadExportArtifact } from '@/lib/tools/csvExportArtifact';

type Row = Record<string, unknown>;
type Filter = {
  op: 'eq' | 'in' | 'neq' | 'lt';
  col: string;
  value: unknown;
};

jest.mock('@/lib/supabaseAdmin', () => {
  let row: Row = {};
  const appliedUpdates: Row[] = [];
  const attemptedUpdates: Array<{ patch: Row; filters: Filter[] }> = [];
  let readErrorsRemaining = 0;

  const matches = (filters: Filter[]) =>
    filters.every(({ op, col, value }) => {
      const current = row[col];
      if (op === 'eq') return current === value;
      if (op === 'neq') return current !== value;
      if (op === 'in') return Array.isArray(value) && value.includes(current);
      return typeof current === 'string' && typeof value === 'string' && current < value;
    });

  const makeQuery = (table: string) => {
    let mode: 'read' | 'update' | 'insert' = 'read';
    let patch: Row = {};
    let returnUpdatedRow = false;
    const filters: Filter[] = [];

    const execute = () => {
      if (table !== 'base_constructor_jobs') {
        return { data: null, error: null };
      }

      if (mode === 'update') {
        attemptedUpdates.push({
          patch: { ...patch },
          filters: filters.map((filter) => ({ ...filter })),
        });
        const matched = matches(filters);
        if (matched) {
          row = { ...row, ...patch };
          appliedUpdates.push({ ...patch });
        }
        return { data: returnUpdatedRow && matched ? { ...row } : null, error: null };
      }

      if (readErrorsRemaining > 0) {
        readErrorsRemaining -= 1;
        return { data: null, error: { message: 'temporary PostgREST read failure' } };
      }

      return { data: matches(filters) ? { ...row } : null, error: null };
    };

    const query: Record<string, unknown> = {
      select: () => {
        if (mode === 'update') returnUpdatedRow = true;
        return query;
      },
      insert: () => {
        mode = 'insert';
        return query;
      },
      update: (nextPatch: Row) => {
        mode = 'update';
        patch = { ...nextPatch };
        return query;
      },
      eq: (col: string, value: unknown) => {
        filters.push({ op: 'eq', col, value });
        return query;
      },
      neq: (col: string, value: unknown) => {
        filters.push({ op: 'neq', col, value });
        return query;
      },
      in: (col: string, value: unknown) => {
        filters.push({ op: 'in', col, value });
        return query;
      },
      lt: (col: string, value: unknown) => {
        filters.push({ op: 'lt', col, value });
        return query;
      },
      single: async () => execute(),
      maybeSingle: async () => execute(),
      then: (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(execute()).then(resolve, reject),
    };
    return query;
  };

  return {
    supabaseAdmin: {
      from: (table: string) => makeQuery(table),
      __setRow: (nextRow: Row) => { row = { ...nextRow }; },
      __replaceRow: (nextRow: Row) => { row = { ...nextRow }; },
      __getRow: () => ({ ...row }),
      __getAppliedUpdates: () => appliedUpdates.map((update) => ({ ...update })),
      __getAttemptedUpdates: () => attemptedUpdates.map((attempt) => ({
        patch: { ...attempt.patch },
        filters: attempt.filters.map((filter) => ({ ...filter })),
      })),
      __failNextReads: (count: number) => { readErrorsRemaining = count; },
      __reset: () => {
        row = {};
        appliedUpdates.length = 0;
        attemptedUpdates.length = 0;
        readErrorsRemaining = 0;
      },
    },
  };
});

jest.mock('@/lib/tools/processingSteps', () => {
  const original = jest.requireActual('@/lib/tools/processingSteps');
  const noop = jest.fn(async (data: string[][]) => data);
  return {
    ...original,
    stepRemoveEmpty: noop,
    stepFullDedup: noop,
    stepEmailDedup: noop,
    stepFindEmails: noop,
    stepSplitEmails: noop,
    stepRemoveSupportEmails: noop,
    stepSiteCheck: noop,
    stepEnrich: noop,
    stepTAScore: noop,
    stepNameCleanup: noop,
    stepPersonalize: noop,
    stepValidateEmails: jest.fn(async (data: string[][]) => data),
  };
});

jest.mock('@/lib/tools/csvExportArtifact', () => ({
  uploadExportArtifact: jest.fn(async () => null),
}));

interface MockAdmin {
  __setRow: (row: Row) => void;
  __replaceRow: (row: Row) => void;
  __getRow: () => Row;
  __getAppliedUpdates: () => Row[];
  __getAttemptedUpdates: () => Array<{ patch: Row; filters: Filter[] }>;
  __failNextReads: (count: number) => void;
  __reset: () => void;
}

type TokenAwareProgress = (
  jobId: string,
  stepIndex: number,
  stepKey: string,
  progress: number,
  runToken: string,
) => Promise<void>;

type TokenAwareRun = (jobId: string, runToken: string) => Promise<void>;

const progressWithToken = updateJobProgress as unknown as TokenAwareProgress;
const runWithToken = runBaseConstructorJob as unknown as TokenAwareRun;
const validateEmailsMock = stepValidateEmails as jest.MockedFunction<typeof stepValidateEmails>;
const uploadExportArtifactMock = jest.mocked(uploadExportArtifact);

const ACTIVE_TOKEN = '11111111-1111-4111-8111-111111111111';
const STALE_TOKEN = '22222222-2222-4222-8222-222222222222';
const NEW_TOKEN = '33333333-3333-4333-8333-333333333333';

const baseJob = (overrides: Row = {}): Row => ({
  id: 'job-token-fence',
  user_id: 'user-1',
  file_name: 'contacts.csv',
  status: 'processing',
  selected_steps: ['validate_emails'],
  step_config: {},
  current_step: 1,
  current_step_key: 'validate_emails',
  current_step_progress: 45,
  total_steps: 1,
  data: [['Email'], ['saved@example.com']],
  run_token: ACTIVE_TOKEN,
  ...overrides,
});

describe('Base Constructor run-token fencing', () => {
  let admin: MockAdmin;

  beforeEach(async () => {
    const supabaseModule = await import('@/lib/supabaseAdmin');
    admin = supabaseModule.supabaseAdmin as unknown as MockAdmin;
    admin.__reset();
    jest.clearAllMocks();
    validateEmailsMock.mockImplementation(async (data) => data);
    uploadExportArtifactMock.mockResolvedValue(null);
  });

  it('lets the active token update progress and rejects the previous token', async () => {
    admin.__setRow(baseJob());

    await progressWithToken('job-token-fence', 0, 'validate_emails', 46, ACTIVE_TOKEN);
    expect(admin.__getRow().current_step_progress).toBe(46);

    await progressWithToken('job-token-fence', 0, 'validate_emails', 99, STALE_TOKEN);
    expect(admin.__getRow().current_step_progress).toBe(46);
    expect(admin.__getRow().run_token).toBe(ACTIVE_TOKEN);
  });

  it('lets the active token persist a checkpoint and complete the job', async () => {
    admin.__setRow(baseJob());
    const checkpoint = [['Email'], ['checkpoint@example.com']];
    const finalRows = [['Email'], ['final@example.com']];

    validateEmailsMock.mockImplementation(async (_data, onProgress, _isCancelled, config) => {
      await onProgress(60);
      await config?.onCheckpoint?.(checkpoint);
      return finalRows;
    });

    await runWithToken('job-token-fence', ACTIVE_TOKEN);

    expect(admin.__getAppliedUpdates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: checkpoint }),
    ]));
    expect(admin.__getRow()).toEqual(expect.objectContaining({
      status: 'completed',
      current_step_key: 'done',
      current_step_progress: 100,
      data: finalRows,
      run_token: ACTIVE_TOKEN,
    }));
    expect(uploadExportArtifactMock).toHaveBeenCalledWith(
      expect.anything(),
      `job-token-fence/${ACTIVE_TOKEN}`,
      finalRows,
    );
  });

  it('does not let an old runner write progress, checkpoint, or final data after a reclaim', async () => {
    admin.__setRow(baseJob({ run_token: STALE_TOKEN }));
    const newOwnerRows = [['Email'], ['new-owner@example.com']];

    validateEmailsMock.mockImplementation(async (_data, onProgress, _isCancelled, config) => {
      // The new worker reclaims the row while the old container is still
      // finishing its current JavaScript turn.
      admin.__replaceRow(baseJob({
        run_token: NEW_TOKEN,
        current_step_progress: 58,
        data: newOwnerRows,
      }));
      await onProgress(80);
      await config?.onCheckpoint?.([['Email'], ['stale-checkpoint@example.com']]);
      return [['Email'], ['stale-final@example.com']];
    });

    await runWithToken('job-token-fence', STALE_TOKEN);

    expect(admin.__getRow()).toEqual(expect.objectContaining({
      status: 'processing',
      current_step_progress: 58,
      data: newOwnerRows,
      run_token: NEW_TOKEN,
    }));
  });

  it('does not let an old runner mark the new owner failed', async () => {
    admin.__setRow(baseJob({ run_token: STALE_TOKEN }));
    const newOwnerRows = [['Email'], ['new-owner@example.com']];

    validateEmailsMock.mockImplementation(async () => {
      admin.__replaceRow(baseJob({
        run_token: NEW_TOKEN,
        current_step_progress: 58,
        data: newOwnerRows,
      }));
      throw new Error('old worker was terminated');
    });

    await runWithToken('job-token-fence', STALE_TOKEN);

    expect(admin.__getRow()).toEqual(expect.objectContaining({
      status: 'processing',
      current_step_progress: 58,
      data: newOwnerRows,
      run_token: NEW_TOKEN,
    }));
    expect(admin.__getRow().error_message).toBeUndefined();
  });

  it('does not mistake transient ownership reads for token loss', async () => {
    admin.__setRow(baseJob());
    validateEmailsMock.mockImplementation(async (data, _onProgress, isCancelled) => {
      // One failure is consumed by isCancelled(), the next by the ownership
      // check after the step returns. Token-fenced writes remain safe while
      // reads recover, so neither failure should kill/strand this owned run.
      admin.__failNextReads(2);
      await expect(isCancelled?.()).resolves.toBe(false);
      return data;
    });

    await runWithToken('job-token-fence', ACTIVE_TOKEN);

    expect(admin.__getRow()).toEqual(expect.objectContaining({
      status: 'completed',
      run_token: ACTIVE_TOKEN,
    }));
  });

  it('does not reset displayed progress below the saved checkpoint when resuming mid-step', async () => {
    admin.__setRow(baseJob({ current_step_progress: 45 }));

    await runWithToken('job-token-fence', ACTIVE_TOKEN);

    const regressions = admin.__getAppliedUpdates().filter((update) =>
      update.current_step_key === 'validate_emails'
      && typeof update.current_step_progress === 'number'
      && update.current_step_progress < 45,
    );
    expect(regressions).toEqual([]);
  });

  it('publishes 100% only together with the durable final rows', async () => {
    // A 60% floor is important: 60 + round((100-60) * 0.99) would round to
    // 100 unless the mapped value itself is capped, not just local progress.
    admin.__setRow(baseJob({ current_step_progress: 60 }));
    const finalRows = [['Email'], ['filtered-final@example.com']];
    validateEmailsMock.mockImplementation(async (_data, onProgress) => {
      // Steps historically emit 100 just before returning. A container can be
      // killed in that gap, so the worker must keep the persisted job at 99
      // until the final data/status update is atomic.
      await onProgress(100);
      return finalRows;
    });

    await runWithToken('job-token-fence', ACTIVE_TOKEN);

    const hundredPercentUpdates = admin.__getAppliedUpdates().filter(
      (update) => update.current_step_progress === 100,
    );
    expect(hundredPercentUpdates).toHaveLength(1);
    expect(hundredPercentUpdates[0]).toEqual(expect.objectContaining({
      status: 'completed',
      data: finalRows,
    }));
  });
});

describe('Base Constructor run-token schema contract', () => {
  it('adds a durable run_token column to base_constructor_jobs', () => {
    const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
    const hasRunTokenMigration = fs.readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
      .some((sql) => /alter table(?: if exists)? public\.base_constructor_jobs .*add column(?: if not exists)? run_token (?:uuid|text)/
        .test(sql.replace(/\s+/g, ' ').toLowerCase()));

    expect(hasRunTokenMigration).toBe(true);
  });
});
