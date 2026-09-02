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
import { stepTAScore, stepValidateEmails } from '@/lib/tools/processingSteps';
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
const taScoreMock = jest.mocked(stepTAScore);
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
    taScoreMock.mockImplementation(async (data) => data);
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
        result_stats: { owner_marker: 'new-owner' },
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
      result_stats: { owner_marker: 'new-owner' },
    }));
  });

  it('keeps step timing and earlier TA stats through checkpoints, resume and completion', async () => {
    const originalStart = '2026-09-03T08:00:00.000Z';
    let now = Date.parse('2026-09-03T10:00:00.000Z');
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const completedTa = {
      step_index: 1, key: 'ta_scoring', started_at: originalStart,
      completed_at: '2026-09-03T08:01:00.000Z', active_ms: 60_000,
      attempts: 1, interrupted: false, input_rows: 10, output_rows: 2,
    };
    admin.__setRow(baseJob({
      selected_steps: ['ta_scoring', 'validate_emails'],
      current_step: 2,
      total_steps: 2,
      result_stats: {
        ta_scoring_failed_rows: 2,
        ta_scoring_length_responses: 4,
        step_timings: { version: 1, steps: [completedTa, {
          step_index: 2, key: 'validate_emails', started_at: originalStart,
          active_ms: 15_000, attempts: 1, interrupted: false, input_rows: 2,
        }] },
      },
    }));
    validateEmailsMock.mockImplementation(async (data, onProgress, _cancel, config) => {
      now += 1_000;
      await onProgress(60);
      await config?.onCheckpoint?.(data);
      const checkpoint = admin.__getRow().result_stats as Record<string, unknown>;
      expect(checkpoint).toEqual(expect.objectContaining({
        ta_scoring_failed_rows: 2,
        step_timings: { version: 1, steps: [completedTa, expect.objectContaining({
          key: 'validate_emails', active_ms: 16_000, attempts: 2,
          interrupted: true, started_at: originalStart,
        })] },
      }));
      now += 2_000;
      return data;
    });
    try {
      await runWithToken('job-token-fence', ACTIVE_TOKEN);
      const stats = admin.__getRow().result_stats as Record<string, unknown>;
      expect(stats).toEqual(expect.objectContaining({
        ta_scoring_failed_rows: 2,
        ta_scoring_length_responses: 4,
        step_timings: { version: 1, steps: [completedTa, expect.objectContaining({
          active_ms: 18_000, attempts: 2, interrupted: true,
          input_rows: 2, output_rows: 1,
          completed_at: new Date(now).toISOString(),
        })] },
      }));
      const metricsWrites = admin.__getAttemptedUpdates().filter(({ patch }) => patch.result_stats);
      expect(metricsWrites.length).toBeGreaterThanOrEqual(3);
      expect(metricsWrites.every(({ filters }) => filters.some((filter) =>
        filter.col === 'run_token' && filter.value === ACTIVE_TOKEN,
      ))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('accumulates TA request telemetry once per attempt while replacing final failure counts', async () => {
    admin.__setRow(baseJob({
      selected_steps: ['ta_scoring'], current_step_key: 'ta_scoring',
      result_stats: {
        ta_scoring_length_responses: 3,
        ta_scoring_failed_rows: 1,
        ta_scoring_telemetry: {
          version: 1, http_attempts: 4, api_duration_ms: 9_000,
          length_responses: 3, unique_companies: 10, models: ['old-model'],
        },
      },
    }));
    taScoreMock.mockImplementation(async (data, _brief, onProgress, _cancel, options) => {
      const telemetry = {
        unique_companies: 10, http_attempts: 2, api_duration_ms: 5_000,
        retry_wait_ms: 500, length_responses: 1, usage_responses: 2,
        prompt_tokens: 100, completion_tokens: 200, reasoning_tokens: 50,
        models: ['new-model'], failed_rows: 0, failed_batches: 0, errors: [],
      };
      const receiver = options as typeof options & { onTelemetry?: (value: typeof telemetry) => void };
      receiver?.onTelemetry?.(telemetry);
      await onProgress(50);
      receiver?.onTelemetry?.(telemetry); // repeated snapshots must not double count
      options?.onStats?.({
        pre_filter_rows: 10, filtered_out_count: 2, pre_filter_avg_score: 8,
        failed_rows: 0, failed_batches: 0, length_responses: 1, errors: [],
      });
      await options?.onCheckpoint?.(data);
      return data;
    });
    await runWithToken('job-token-fence', ACTIVE_TOKEN);
    expect(admin.__getRow().result_stats).toEqual(expect.objectContaining({
      ta_scoring_failed_rows: 0,
      ta_scoring_length_responses: 4,
      ta_scoring_telemetry: expect.objectContaining({
        version: 1, complete: true, interrupted: true,
        http_attempts: 6, api_duration_ms: 14_000, retry_wait_ms: 500,
        length_responses: 4, usage_responses: 2, prompt_tokens: 100,
        completion_tokens: 200, reasoning_tokens: 50,
        unique_companies: 10, failed_rows: 0, failed_batches: 0,
        models: ['old-model', 'new-model'],
      }),
    }));
    // The filtered final checkpoint may be durable before the final status.
    // Replaying its already-scored rows must not shrink the original metrics.
    admin.__setRow({ ...admin.__getRow(), status: 'processing',
      current_step_key: 'ta_scoring', current_step_progress: 99 });
    taScoreMock.mockImplementation(async (data, _brief, _progress, _cancel, options) => {
      const receiver = options as typeof options & { onTelemetry?: (value: Record<string, unknown>) => void };
      receiver?.onTelemetry?.({
        unique_companies: 1, http_attempts: 0, api_duration_ms: 0, retry_wait_ms: 0,
        length_responses: 0, usage_responses: 0, prompt_tokens: 0, completion_tokens: 0,
        reasoning_tokens: 0, models: [], failed_rows: 0, failed_batches: 0, errors: [],
      });
      options?.onStats?.({ pre_filter_rows: 1, filtered_out_count: 0, pre_filter_avg_score: 9,
        failed_rows: 0, failed_batches: 0, length_responses: 0, errors: [] });
      return data;
    });
    await runWithToken('job-token-fence', ACTIVE_TOKEN);
    expect(admin.__getRow().result_stats).toEqual(expect.objectContaining({
      ta_scoring_pre_filter_rows: 10, ta_scoring_filtered_out: 2,
      ta_scoring_pre_filter_avg: 8, ta_scoring_length_responses: 4,
      ta_scoring_telemetry: expect.objectContaining({ http_attempts: 6, unique_companies: 10 }),
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
